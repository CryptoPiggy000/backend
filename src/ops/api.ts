import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Store } from "./store";

export interface ApiOptions {
  adminKey?: string; // bearer token for /ops/*; unset → admin endpoints disabled
  corsOrigin?: string;
  // Live per-venue breakdown for /account/:addr (the worker wires this from chain; the local test omits
  // it → positions come back empty). APY isn't included — it lives in the engine; the client enriches.
  positionsFor?: (
    account: string,
  ) => Promise<{ key: string; name: string; class: "savings" | "crypto"; valueUsd: number }[]>;
}

/** µUSD (6dp integer string) → a USD number with cents. Launch scale fits a double comfortably. */
const usd = (micros: string | number | null | undefined): number => Math.round(Number(micros ?? 0)) / 1e6;

/**
 * The ops JSON API:
 *   PUBLIC  GET /stats               — safe aggregates the app renders (no addresses)
 *   PUBLIC  GET /account/:addr       — ONE account's own portfolio value + activity (the app's Portfolio)
 *   ADMIN   GET /ops/accounts        — per-account list (owner, principal, live value)
 *   ADMIN   GET /ops/account/:addr   — one account: flows + value history
 *   ADMIN   GET /ops/activity?limit= — recent deposit/withdraw feed
 * Admin routes require `Authorization: Bearer <ADMIN_KEY>`.
 */
export function createApi(store: Store, opts: ApiOptions = {}): Hono {
  const app = new Hono();
  app.use("*", cors({ origin: opts.corsOrigin || "*" }));

  const denied = (auth: string | undefined): Response | null => {
    if (!opts.adminKey) return Response.json({ error: "admin endpoints disabled" }, { status: 403 });
    if (auth !== `Bearer ${opts.adminKey}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    return null;
  };

  app.get("/stats", async (c) => {
    const agg = await store.aggregate();
    const values = await store.latestValues();
    let aum = 0;
    for (const v of values.values()) aum += Number(v);
    const feeBps = Number((await store.getMeta("fee_bps")) ?? 0);
    return c.json({
      users: agg.users,
      totalDeposited: usd(agg.totalDeposited),
      totalWithdrawn: usd(agg.totalWithdrawn),
      netPrincipal: usd(Number(agg.totalDeposited) - Number(agg.totalWithdrawn)),
      aum: usd(aum),
      revenue: usd(agg.totalFees), // deposit fees collected to date
      currentFeeBps: feeBps, // the live deposit-fee rate (0 = off)
      currentFeePct: feeBps / 100,
      unit: "usd",
      updatedAt: Date.now(),
    });
  });

  // Governance audit trail: every registry admin action (fee/cap/whitelist/protocol/asset/route/…).
  app.get("/ops/audit", async (c) => {
    const no = denied(c.req.header("Authorization"));
    if (no) return no;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 1000);
    const events = await store.adminEvents(limit);
    return c.json({
      events: events.map((e) => ({
        event: e.event,
        args: JSON.parse(e.args),
        block: e.block,
        ts: e.ts,
        txHash: e.tx_hash,
      })),
    });
  });

  // PUBLIC per-account view for the app's Portfolio. Everything here — an account's balance, cost
  // basis, and deposit/withdraw history — is already public on-chain; we just serve the pre-indexed
  // version so the client doesn't have to read the chain itself. Unlike /ops/account/:addr it omits
  // the owner and the full value history, and needs no admin key: an address only exposes its own
  // already-public activity.
  app.get("/account/:addr", async (c) => {
    const addr = c.req.param("addr").toLowerCase();
    const [values, principals] = await Promise.all([store.latestValues(), store.accountPrincipals()]);
    const value = Number(values.get(addr) ?? 0);
    const principal = Number(principals.get(addr) ?? 0);
    const flows = await store.accountFlows(addr);
    // Only read live positions for an address we actually index. /account is public + unauthenticated and
    // the venue tokens (WETH / aToken / Morpho vault) are SHARED across all of Base, so reading positions
    // for an arbitrary address would (a) fire ~10 paid RPC calls on demand — a cost-abuse vector — and
    // (b) report that address's unrelated holdings as "positions" while value/principal read 0 from D1.
    // Membership is decided from data already fetched (no extra query).
    const known = values.has(addr) || principals.has(addr) || flows.length > 0;
    // Per-venue breakdown (savings vaults + crypto held assets), read live for this one account.
    // positionsFor owns the normal failure path (serves the last-good breakdown on a transient RPC error
    // rather than blanking the portfolio). The catch here is a last-resort backstop ONLY: a positions-read
    // fault must never 500 the whole response and take value/principal/accrued/activity (all from D1) down
    // with it. It no longer masks the rate-limit bug — that's handled upstream in positionsFor.
    const positions = known && opts.positionsFor ? await opts.positionsFor(addr).catch(() => []) : [];
    // "Interest earned" = value of what's DEPLOYED − its cost basis. Use the live positions' value
    // (savings + crypto), NOT `value` — `value` also includes idle USDC sitting in the account, which is
    // not a gain, so `value − principal` mislabels idle cash as accrued interest. `principal` is the
    // net-into-positions cost basis, so positionsValue − principal is the true gain/loss on deployed money.
    const deployedUsd = positions.reduce((sum, p) => sum + p.valueUsd, 0);
    return c.json({
      account: addr,
      principal: usd(principal),
      value: usd(value),
      accrued: Math.max(0, deployedUsd - usd(principal)),
      positions,
      activity: flows
        .map((f) => ({ kind: f.kind, amount: usd(f.amount), ts: f.ts, txHash: f.tx_hash }))
        .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
        .slice(0, 50),
    });
  });

  app.get("/ops/accounts", async (c) => {
    const no = denied(c.req.header("Authorization"));
    if (no) return no;
    const [accounts, values, principals] = await Promise.all([
      store.listAccounts(),
      store.latestValues(),
      store.accountPrincipals(),
    ]);
    return c.json({
      accounts: accounts.map((a) => ({
        account: a.account,
        owner: a.owner,
        createdTs: a.created_ts ?? null,
        principal: usd(principals.get(a.account) ?? 0),
        value: usd(values.get(a.account) ?? 0),
      })),
    });
  });

  app.get("/ops/account/:addr", async (c) => {
    const no = denied(c.req.header("Authorization"));
    if (no) return no;
    const addr = c.req.param("addr").toLowerCase();
    const [accounts, values, principals] = await Promise.all([
      store.listAccounts(),
      store.latestValues(),
      store.accountPrincipals(),
    ]);
    const acct = accounts.find((a) => a.account === addr);
    if (!acct) return c.json({ error: "unknown account" }, 404);
    const [flows, history] = await Promise.all([store.accountFlows(addr), store.accountValues(addr)]);
    return c.json({
      account: acct.account,
      owner: acct.owner,
      createdTs: acct.created_ts ?? null,
      principal: usd(principals.get(addr) ?? 0),
      value: usd(values.get(addr) ?? 0),
      flows: flows.map((f) => ({ kind: f.kind, amount: usd(f.amount), block: f.block, ts: f.ts, txHash: f.tx_hash })),
      valueHistory: history.map((v) => ({ value: usd(v.value_usd), block: v.block, ts: v.ts })),
    });
  });

  app.get("/ops/activity", async (c) => {
    const no = denied(c.req.header("Authorization"));
    if (no) return no;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 500);
    const flows = await store.recentFlows(limit);
    return c.json({
      items: flows.map((f) => ({
        account: f.account,
        owner: f.owner ?? null,
        kind: f.kind,
        amount: usd(f.amount),
        block: f.block,
        ts: f.ts,
        txHash: f.tx_hash,
      })),
    });
  });

  return app;
}
