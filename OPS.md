# cryptopiggy-ops — the operations indexer

A **second worker in this repo** (separate from the public proxy `cryptopiggy-backend`) that indexes
**our own** protocol contracts and serves a JSON API. It answers "how are we doing": new accounts,
deposits, withdrawals, net principal, and live per-account portfolio value.

- Code: `src/ops/` · Config: `wrangler.ops.toml` · Schema: `src/ops/schema.sql`
- Store: the **shared** `cryptopiggy_market` D1 (the engine's DB), in `ops_`-prefixed tables. Idempotent
  DDL (not wrangler migrations) so it never touches the engine's tables.
- Two crons: `*/5 * * * *` log-index (accounts + flows), `*/30 * * * *` value snapshot.
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

Admin auth: `Authorization: Bearer <ADMIN_KEY>`. `/stats` is what the web app renders later.

## Local test (anvil)

```bash
npm run test:ops    # starts anvil, runs contracts/script/OpsScenario.s.sol, asserts the passes + API
```

## Deploy to Base

The indexer reads **our** registry + factory — so this can only go live **after the Base contract
deploy** (`DeployBase`), which mints those addresses and the deploy block.

1. **Fill `wrangler.ops.toml` `[env.production.vars]`** from the `DeployBase` broadcast:
   - `REGISTRY`, `FACTORY` — the deployed addresses
   - `DEPLOY_BLOCK` — the block they were deployed at (backfill start)
   - `HELD_ASSETS` — `["<WETH>","<cbBTC>"]` (the held-asset tokens to value)
   - `ATOKENS` — `{"<aavePool>:<usdc>":"<aBasUSDC>"}` for accurate accruing Aave value
     (Base Aave V3 aUSDC; from `PoolDataProvider.getReserveTokensAddresses(USDC)`)
   - `CHAINLINK` — `{"<WETH>":"<ETH/USD feed>","<cbBTC>":"<BTC/USD feed>"}` (Base Chainlink feeds)
2. **Secret:** `wrangler secret put ADMIN_KEY --env production -c wrangler.ops.toml`
3. **Apply the schema** to the shared D1 (once):
   `npx wrangler d1 execute cryptopiggy_market --file src/ops/schema.sql --remote`
4. **Deploy:** `npm run deploy:ops`
5. **Backfill:** the crons pick it up, or force it now:
   `curl -XPOST -H "Authorization: Bearer $ADMIN_KEY" https://cryptopiggy-ops.../ops/reindex`

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
