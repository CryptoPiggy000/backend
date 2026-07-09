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

Transparent proxy — every path is forwarded to the engine unchanged, so the contract is the engine's
(`../engine/README.md`). **The canonical API contract the engine must implement is
[`web/API.md`](https://github.com/CryptoPiggy000/web/blob/main/API.md)** — auth, `/me/portfolio`
(two-bucket Resting/Earning), the `/operations/*` build→sign→submit model with sponsored UserOps,
`/onramp/*`, and `/me/activity`. `web/FLOW.md` is the UX-level flow only; on any conflict, **API.md wins**.

Note the engine must forward `Authorization` and `Idempotency-Key` (this proxy already preserves them),
and build `/operations/withdraw` as withdraw-to-owner + ERC-20 transfer batched in one UserOp when the
destination isn't the owner (the on-chain `SmartInvestmentAccount.withdraw` sends to owner only).

The backend only adds CORS and strips hop-by-hop headers so bodies aren't double-encoded. Public-facing
concerns (rate-limiting, WAF, multi-client keys) attach here later; the intelligence stays private in the engine.
