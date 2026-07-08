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
npx wrangler dev --port 8789    # http://localhost:8789, forwards to ENGINE_URL (default 127.0.0.1:8788)
```

Needs the engine running (`cd ../engine && npx wrangler dev --port 8788`).

Config in `wrangler.toml` `[vars]`:

- **DEV** — `ENGINE_URL` points at the engine's local dev server.
- **PROD** — uncomment the `[[services]]` binding to `cryptopiggy-engine` so the engine stays off the
  public internet; the code prefers the binding when present and falls back to `ENGINE_URL` otherwise.
- `CORS_ORIGIN` — allowed origin (`*` in dev; the app's domain in prod).

## API

Transparent proxy — every path is forwarded to the engine unchanged, so the contract is the engine's
(`../engine/README.md`, from `web/FLOW.md`). The backend only adds CORS and strips hop-by-hop headers so
bodies aren't double-encoded. Public-facing concerns (rate-limiting, WAF, multi-client keys) attach here
later; the intelligence stays private in the engine.
