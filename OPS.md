# cryptopiggy-ops — the operations indexer

A **second worker in this repo** (separate from the public proxy `cryptopiggy-backend`) that indexes
**our own** protocol contracts and serves a JSON API. It answers "how are we doing": new accounts,
deposits, withdrawals, net principal, and live per-account portfolio value.

- Code: `src/ops/` · Config: `wrangler.ops.toml` · Schema: `src/ops/schema.sql`
- Store: the **shared** `cryptopiggy_market` D1 (the engine's DB), in `ops_`-prefixed tables. Idempotent
  DDL (not wrangler migrations) so it never touches the engine's tables.
- Two crons (spaced so they never share a minute): `*/10 * * * *` log-index (accounts + flows + revenue
  + audit), `5,35 * * * *` value snapshot.
- **Live on Base since 2026-07-27** → `https://cryptopiggy-ops-production.ai-suggestion.workers.dev`
  (pointed at the deployed registry/factory — see `contracts/DEPLOYMENTS.md`).
- Design: `docs/superpowers/specs/2026-07-21-ops-indexer-design.md` (in the super-repo).

## API

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/stats` | public | `{ users, totalDeposited, totalWithdrawn, netPrincipal, aum, revenue, currentFeeBps, currentFeePct, unit, updatedAt }` (USD; no addresses) |
| GET | `/account/:addr` | public | one account's OWN portfolio for the app: `{ account, principal, value, accrued, positions[], activity[] }`. `value`/`principal`/`accrued`/`activity` are pre-indexed from D1; `positions[]` is the LIVE per-venue breakdown (Aave / vaults / held×price), read on demand, **cached** (15s) and **gated to indexed accounts** (arbitrary addresses → `[]`, no paid read). No owner / full value history (admin-only). |
| GET | `/ops/accounts` | bearer | `[{ account, owner, createdTs, principal, value }]` |
| GET | `/ops/account/:addr` | bearer | one account: `flows[]` + `valueHistory[]` |
| GET | `/ops/activity?limit=` | bearer | recent deposit/withdraw feed |
| GET | `/ops/audit?limit=` | bearer | governance audit trail — every registry admin action (`{ event, args, block, ts, txHash }`) |
| GET | `/health` | public | liveness |
| POST | `/ops/migrate` `/ops/reindex` `/ops/revalue` | bearer | bootstrap schema / force a pass (backfill, debug) |

Admin auth: `Authorization: Bearer <ADMIN_KEY>`. The app's Portfolio reads `/account/:addr`; `/stats` is
for public/marketing aggregates. Web deploy guide: `web/DEPLOY.md`.

## Local test (anvil)

```bash
npm run test:ops    # starts anvil, runs contracts/script/OpsScenario.s.sol, asserts the passes + API
```

## Deployed & how to operate

Already deployed on Base (the `[env.production.vars]` are filled with the live registry/factory,
`DEPLOY_BLOCK=49169715`, `HELD_ASSETS` WETH+cbBTC, `ATOKENS` aBasUSDC, `CHAINLINK` ETH/USD+BTC/USD).
Secrets (`ADMIN_KEY`, `RPC`, `READ_RPC_BEARER`) are wrangler secrets + mirrored in gitignored `.env.production.secrets`.

**Two RPCs — cheap/steady on free, bursty on paid.** The cron passes and the live `/account` reads have
different needs, so they use different endpoints:

- **`RPC`** (secret) — the **cron passes** (`eth_getLogs` + valuation). Must be **keyed + archive-capable**:
  free public Base RPCs don't serve `eth_getLogs` from Cloudflare egress (publicnode blocks archive;
  mainnet.base.org hangs the isolate). Ours is zan.top (~20 RPS / CU-limited). The passes are serialized +
  spaced by the throttled client (`MAX_RPS` in `chain.ts`) and run on non-overlapping crons — keep both.
  Set: `wrangler secret put RPC --env production -c wrangler.ops.toml`.
- **`READ_RPC`** (var, no key in the URL) + **`READ_RPC_BEARER`** (secret) — the **live `/account`
  positions read**. Blockmachine (`https://rpc-base.blockmachine.io`), authed via `Authorization: Bearer`.
  These reads are bursty and concurrent; sharing `RPC`'s CU budget used to 429 them → an uncaught read
  threw → positions blanked (the `positions:[]` flicker) and concurrent hits 500'd the worker. They now go
  to a high-headroom provider, **batched** into ~1 round-trip (`makeReadClient`, viem `batch:true`,
  un-throttled — the provider absorbs the concurrency) and **cached** per-account (15s TTL + single-flight,
  `positions-cache.ts`) with a last-good fallback. Falls back to `RPC` when `READ_RPC` is unset
  (local/anvil). Set the key: `wrangler secret put READ_RPC_BEARER --env production -c wrangler.ops.toml`.

Common ops:
- **Redeploy after a code change:** `npm run deploy:ops`
- **Rotate a key:** `wrangler secret put RPC|READ_RPC_BEARER|ADMIN_KEY --env production -c wrangler.ops.toml`
- **Force a backfill/refresh (admin):**
  `curl -XPOST -H "Authorization: Bearer $ADMIN_KEY" $OPS_URL/ops/reindex` (logs) · `/ops/revalue` (values)
- **Bootstrap schema on a fresh D1:** `/ops/migrate` (the crons + reindex also apply it idempotently)

### Re-deploying from scratch (if ever needed)
1. Fill `[env.production.vars]` from the `DeployBase` output (REGISTRY/FACTORY/DEPLOY_BLOCK + HELD_ASSETS
   / ATOKENS / CHAINLINK; `READ_RPC` is already there). 2. `wrangler secret put ADMIN_KEY` + `RPC` (keyed
   archive) + `READ_RPC_BEARER` (Blockmachine). 3. `npm run deploy:ops`. 4. `curl -XPOST …/ops/reindex` to
   backfill.

## Notes

- Monetary values are stored as canonical **µUSD** (6dp integer) so the math is chain-agnostic
  (anvil USDC is 18dp, Base USDC is 6dp); the API returns plain USD numbers.
- `netDeployed`/principal is **cost basis** (what accounts deployed), not market value; `value`/`aum`
  is the live on-chain value incl. yield/gains from the snapshot pass.
- Reorg buffer: indexes up to `latest − CONFIRMATIONS` (5 on Base). Cursor is stored in `ops_meta`.
- **Revenue** (`/stats.revenue`) is the sum of the account-level `DepositFeePaid` events (the entry fee),
  indexed topic-only across the account clones and stored as `fee` rows in `ops_flows`.
- **`/account` positions are the only LIVE read** (everything else is pre-indexed from D1). They go to
  `READ_RPC` (Blockmachine), batched + cached (15s TTL, single-flight) + gated to indexed accounts +
  last-good on error. NB: the app on **Base reads the portfolio _balance_ from chain** (an atomic
  multicall) for freshness — it consumes `/account` only for the activity feed + accrued interest, so a
  brief ops hiccup can't move the displayed balance.
- **Governance audit** (`/ops/audit`): all 13 `ProtocolRegistry` admin events (fee/cap/whitelist/
  protocol/asset/route/factory/base-asset changes) are indexed into `ops_admin_events` — the on-chain
  record that admin powers stayed within bounds. The **current** fee is read live each pass and shown as
  `/stats.currentFeeBps` (history is in the audit feed).
