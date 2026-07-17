# CryptoPiggy — backend (public Cloudflare Worker)

The **public**, deliberately-simple edge. A TypeScript **Cloudflare Worker** that serves clients (CORS)
and **forwards** every request to the **private engine Worker** (`../engine`), which does the indexing,
planning, and storage. The backend holds **no key**, no store, no chain access, and no logic worth
hiding — the moat lives in the engine.

```
client → backend (public CORS proxy, this) → engine (private Worker) → Plan + Actions
```

## Run (local dev)

```shell
npm install
npx wrangler dev --port 8789    # http://localhost:8789
```

By default (`MOCK = "true"` in `wrangler.toml`) this serves an **in-repo mock engine**
(`src/mock.ts`) that implements the [`web/API.md`](https://github.com/CryptoPiggy000/web/blob/main/API.md)
contract in-memory — so the frontend has a real backend to hit **before the private engine exists**.
Point the app's `NEXT_PUBLIC_API_URL` at `http://localhost:8789`.

To proxy to the **real engine** instead: set `MOCK = "false"` and run the engine
(`cd ../engine && npx wrangler dev --port 8788`), or bind `ENGINE` in prod. When the engine is
bound/reachable the mock is bypassed and this stays a pure proxy.

Config in `wrangler.toml` `[vars]`:

- **DEV** — `ENGINE_URL` points at the engine's local dev server.
- **PROD** — uncomment the `[[services]]` binding to `cryptopiggy-engine` so the engine stays off the
  public internet; the code prefers the binding when present and falls back to `ENGINE_URL` otherwise.
- `CORS_ORIGIN` — allowed origin (`*` in dev; the app's domain in prod).

## API

**Engine-backed `/market/*` (suggestion-only).** The private engine speaks `/plan`, not `web/API.md`, so
two paths are mapped here (`src/engine.ts`) rather than blind-proxied:
- `GET /market/strategies?term=` → calls the planner `/plan` at 3 risk presets (safe/balanced/bold) →
  the chooser shape (savings/crypto split, steady yield, expected return + downside/upside range, named mix).
- `POST /market/plan` `{ strategy|risk, amount, term, holdings? }` → the planner `/plan` → the full
  `{ allocation, actions, summary, reasoning }` for the app's **View plan** detail.

They hit the planner via `PLANNER_URL` (dev) or a `PLANNER` service binding (prod), and fall back to the
mock if the engine is unreachable. Everything else is still forwarded/mocked.

Transparent proxy — every other path is forwarded to the engine unchanged, so the contract is the engine's
(`../engine/README.md`). **The canonical API contract is
[`web/API.md`](https://github.com/CryptoPiggy000/web/blob/main/API.md)** — read its design principle:
**the engine only *suggests* an allocation; it never moves funds and the app runs full without it.** The
core money loop is client ↔ contracts (the user builds the `Action[]` and signs `executePlan` directly).
So the engine's real jobs are **`GET /market/strategies` (suggest)** + enrichment (`/me/portfolio`,
`/me/activity`, APY) + the **fiat on-ramp** (`/onramp/*`, the one part that genuinely needs the server).
The `/operations/*` build→sign→submit endpoints are an **optional assist** (pre-build a sponsored op when
routing/`minOut`/rebalancing needs smarts). `web/FLOW.md` is UX-level only; on conflict, **API.md wins**.

If the engine does offer the `/operations/*` assist: forward `Authorization` + `Idempotency-Key` (this
proxy preserves them), and build `/operations/withdraw` as withdraw-to-owner + ERC-20 transfer batched in
one UserOp when the destination isn't the owner (on-chain `SmartInvestmentAccount.withdraw` → owner only).

The backend only adds CORS and strips hop-by-hop headers so bodies aren't double-encoded. Public-facing
concerns (rate-limiting, WAF, multi-client keys) attach here later; the intelligence stays private in the engine.
