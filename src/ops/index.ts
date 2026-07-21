import type { Address } from "viem";
import { createApi } from "./api";
import { makeClient, type OpsConfig } from "./chain";
import { runIndexPass } from "./indexer";
import schema from "./schema.sql";
import { D1Store } from "./store";
import { runValuePass } from "./value";

interface Env {
  DB: D1Database;
  RPC: string;
  REGISTRY: string;
  FACTORY: string;
  DEPLOY_BLOCK?: string;
  CONFIRMATIONS?: string;
  RANGE?: string;
  CORS_ORIGIN?: string;
  HELD_ASSETS?: string;
  ATOKENS?: string;
  CHAINLINK?: string;
  PRICE_OVERRIDES?: string;
  ADMIN_KEY?: string; // bearer for /ops/* + the manual trigger endpoints; unset → those are disabled
}

function jsonVar<T>(s: string | undefined, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

const lowerKeys = <T>(o: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

function config(env: Env): OpsConfig {
  return {
    registry: env.REGISTRY as Address,
    factory: env.FACTORY as Address,
    deployBlock: BigInt(env.DEPLOY_BLOCK ?? "0"),
    confirmations: BigInt(env.CONFIRMATIONS ?? "5"),
    range: BigInt(env.RANGE ?? "3000"),
    aTokens: lowerKeys(jsonVar<Record<string, string>>(env.ATOKENS, {})),
    chainlink: lowerKeys(jsonVar<Record<string, string>>(env.CHAINLINK, {})),
    priceOverrides: lowerKeys(jsonVar<Record<string, number>>(env.PRICE_OVERRIDES, {})),
    heldAssets: jsonVar<string[]>(env.HELD_ASSETS, []).map((a) => a as Address),
  };
}

// Serialize a pass result (has bigints) for a JSON response.
const serialize = (r: object) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

const authed = (req: Request, key?: string): boolean =>
  Boolean(key) && req.headers.get("Authorization") === `Bearer ${key}`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const store = new D1Store(env.DB);
    const app = createApi(store, { adminKey: env.ADMIN_KEY, corsOrigin: env.CORS_ORIGIN });

    app.get("/health", (c) => c.json({ ok: true, worker: "cryptopiggy-ops" }));

    // Admin manual triggers (bearer ADMIN_KEY): bootstrap schema + force a pass (backfill / debug).
    app.post("/ops/migrate", async (c) => {
      if (!authed(c.req.raw, env.ADMIN_KEY)) return c.json({ error: "unauthorized" }, 401);
      await store.init(schema);
      return c.json({ ok: true });
    });
    app.post("/ops/reindex", async (c) => {
      if (!authed(c.req.raw, env.ADMIN_KEY)) return c.json({ error: "unauthorized" }, 401);
      await store.init(schema);
      return c.json(serialize(await runIndexPass(makeClient(env.RPC), store, config(env))));
    });
    app.post("/ops/revalue", async (c) => {
      if (!authed(c.req.raw, env.ADMIN_KEY)) return c.json({ error: "unauthorized" }, 401);
      await store.init(schema);
      return c.json(serialize(await runValuePass(makeClient(env.RPC), store, config(env))));
    });

    return app.fetch(req);
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const store = new D1Store(env.DB);
    await store.init(schema); // idempotent; guarantees tables before the first pass
    const client = makeClient(env.RPC);
    const cfg = config(env);
    // The 30-min cron does the value snapshot; every other tick is the fast log-index.
    if (event.cron === "*/30 * * * *") await runValuePass(client, store, cfg);
    else await runIndexPass(client, store, cfg);
  },
};
