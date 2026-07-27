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
| GET | `/account/:addr` | public | one account's OWN portfolio for the app: `{ account, principal, value, accrued, activity[] }` — all public on-chain data, pre-indexed (no owner, no full value history; that stays admin) |
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
Secrets (`ADMIN_KEY`, `RPC`) are wrangler secrets + mirrored in gitignored `.env.production.secrets`.

**RPC must be KEYED.** Free public Base RPCs don't serve `eth_getLogs` from Cloudflare Worker egress
(publicnode blocks archive requests; mainnet.base.org hangs the isolate). We use a keyed endpoint set as
a **secret** (never in the toml): `wrangler secret put RPC --env production -c wrangler.ops.toml`. The
provider's RPS cap (ours: 20) is respected by the throttled client (`MAX_RPS` in `chain.ts`, serialized
+ spaced) plus the non-overlapping crons — don't remove either.

Common ops:
- **Redeploy after a code change:** `npm run deploy:ops`
- **Rotate the RPC/admin key:** `wrangler secret put RPC|ADMIN_KEY --env production -c wrangler.ops.toml`
- **Force a backfill/refresh (admin):**
  `curl -XPOST -H "Authorization: Bearer $ADMIN_KEY" $OPS_URL/ops/reindex` (logs) · `/ops/revalue` (values)
- **Bootstrap schema on a fresh D1:** `/ops/migrate` (the crons + reindex also apply it idempotently)

### Re-deploying from scratch (if ever needed)
1. Fill `[env.production.vars]` from the `DeployBase` output (REGISTRY/FACTORY/DEPLOY_BLOCK + HELD_ASSETS
   / ATOKENS / CHAINLINK). 2. `wrangler secret put ADMIN_KEY` + `wrangler secret put RPC` (keyed). 3.
   `npm run deploy:ops`. 4. `curl -XPOST …/ops/reindex` to backfill.

## Notes

- Monetary values are stored as canonical **µUSD** (6dp integer) so the math is chain-agnostic
  (anvil USDC is 18dp, Base USDC is 6dp); the API returns plain USD numbers.
- `netDeployed`/principal is **cost basis** (what accounts deployed), not market value; `value`/`aum`
  is the live on-chain value incl. yield/gains from the snapshot pass.
- Reorg buffer: indexes up to `latest − CONFIRMATIONS` (5 on Base). Cursor is stored in `ops_meta`.
- **Revenue** (`/stats.revenue`) is the sum of the account-level `DepositFeePaid` events (the entry fee),
  indexed topic-only across the account clones and stored as `fee` rows in `ops_flows`.
- **Governance audit** (`/ops/audit`): all 13 `ProtocolRegistry` admin events (fee/cap/whitelist/
  protocol/asset/route/factory/base-asset changes) are indexed into `ops_admin_events` — the on-chain
  record that admin powers stayed within bounds. The **current** fee is read live each pass and shown as
  `/stats.currentFeeBps` (history is in the audit feed).
