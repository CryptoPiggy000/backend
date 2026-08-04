// The public Worker. Non-custodial by construction: it holds no key, no store, no chain access —
// it only adds CORS and forwards every request to the private engine, which does the real work.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { mockApp } from "./mock";
import { callPlanner, toStrategy, asTerm, PRESETS, PRESET_RISK, NOMINAL_TOWORK } from "./engine";
import { bestQuote } from "./aggregators";
import { withSponsorshipPolicy } from "./gasless";

interface Env {
  ENGINE_URL: string;   // DEV: engine's wrangler dev URL
  ENGINE?: Fetcher;     // PROD: private service binding (keeps the engine off the public internet)
  PLANNER_URL?: string; // DEV: the engine PLANNER's wrangler dev URL (the app's /market/* calls it)
  PLANNER?: Fetcher;    // PROD: private service binding to cryptopiggy-planner
  CORS_ORIGIN: string;
  MOCK?: string;        // DEV: "true" → serve the in-repo mock engine (no real engine yet)
  ZEROX_API_KEY?: string;   // 0x Swap API v2 key (secret) — for /market/quote
  KYBER_CLIENT_ID?: string; // KyberSwap client id (rate-limit identifier)
  PIMLICO_API_KEY?: string; // Pimlico API key (secret) — injected server-side by the /gasless/rpc proxy
  PIMLICO_SPONSORSHIP_POLICY_ID?: string; // Pimlico sponsorship policy — stamped server-side so the
                            // dashboard spend caps bind; unset → client-controlled (see gasless.ts)
}

// Chains the gasless proxy is willing to forward to Pimlico for. 8453 = Base (prod), 11155111 = Sepolia (dev).
const PIMLICO_CHAINS = new Set<number>([8453, 11155111]);

// JSON-RPC methods the app's permissionless client actually uses against the Pimlico endpoint (paymaster
// ERC-7677 + pimlico bundler extras + standard bundler/client). Everything else is rejected so this
// proxy never becomes a generic open relay for Pimlico's paid infrastructure.
const PIMLICO_METHODS = new Set([
  // paymaster (ERC-7677)
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
  "pm_sponsorUserOperation",
  "pm_validateSponsorshipPolicies",
  // pimlico-specific bundler methods
  "pimlico_getUserOperationGasPrice",
  "pimlico_getUserOperationStatus",
  // standard bundler + client methods
  "eth_chainId",
  "eth_supportedEntryPoints",
  "eth_estimateUserOperationGas",
  "eth_sendUserOperation",
  "eth_getUserOperationByHash",
  "eth_getUserOperationReceipt",
]);

const app = new Hono<{ Bindings: Env }>();

app.use("*", (c, next) => cors({ origin: c.env.CORS_ORIGIN || "*" })(c, next));

// ── Engine-backed /market/* (SUGGESTION-ONLY) ──────────────────────────────────────────────
// The engine's real job: suggest allocations. These two hit the private planner and map its plan into
// the app's shapes. On any engine error we fall back to the mock (dev) so the chooser still works.

// The 3 suggested strategies (risk presets), conditioned on ?term (default 1y).
app.get("/market/strategies", async (c) => {
  const term = asTerm(c.req.query("term"));
  try {
    const plans = await Promise.all(
      PRESETS.map((p) => callPlanner(c.env, { toWork: NOMINAL_TOWORK, risk: p.risk, term })),
    );
    return c.json({ strategies: PRESETS.map((p, i) => toStrategy(p, term, plans[i])) });
  } catch (e) {
    console.error("[market/strategies] engine unreachable, falling back to mock:", e);
    if (!c.env.ENGINE && c.env.MOCK === "true") return mockApp.fetch(c.req.raw, c.env);
    return c.json({ error: { code: "engine_unavailable", message: "engine unreachable" } }, 502);
  }
});

// The full plan for a chosen strategy/risk + amount — the "View plan" detail (allocation + actions).
app.post("/market/plan", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    strategy?: string; risk?: number; term?: string; amount?: string; toWork?: string;
    address?: string; holdings?: unknown;
  };
  const risk = typeof body.risk === "number" ? body.risk : (PRESET_RISK[body.strategy ?? ""] ?? 0.5);
  try {
    const plan = await callPlanner(c.env, {
      address: body.address,
      toWork: String(body.amount ?? body.toWork ?? NOMINAL_TOWORK),
      risk,
      term: asTerm(body.term),
      holdings: body.holdings,
    });
    return c.json(plan);
  } catch (e) {
    console.error("[market/plan] engine unreachable:", e);
    return c.json({ error: { code: "engine_unavailable", message: "engine unreachable" } }, 502);
  }
});

// Best swap quote across the DEX aggregators (0x + KyberSwap). Server-side because the 0x key is a
// secret; returns the fields the client drops into a SWAP Action (approve `router`, relay `routeData`,
// contract enforces `minOut`). `quotedBy` shows what each provider offered.
app.post("/market/quote", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as {
    sellToken?: string; buyToken?: string; sellAmount?: string; taker?: string; slippageBps?: number; chainId?: number;
  };
  if (!b.sellToken || !b.buyToken || !b.sellAmount || !b.taker) {
    return c.json({ error: { code: "bad_request", message: "sellToken, buyToken, sellAmount, taker required" } }, 400);
  }
  const result = await bestQuote(c.env, {
    chainId: b.chainId ?? 8453, // Base
    sellToken: b.sellToken,
    buyToken: b.buyToken,
    sellAmount: b.sellAmount,
    taker: b.taker,
    slippageBps: b.slippageBps ?? 100, // 1% default
  });
  if (!result) return c.json({ error: { code: "no_route", message: "no aggregator route available" } }, 502);
  return c.json({ ...result.best, quotedBy: result.all.map((q) => ({ provider: q.provider, buyAmount: q.buyAmount })) });
});

// ── Pimlico gasless proxy ─────────────────────────────────────────────────────────
// The app's permissionless client points its paymaster + bundler transport at this route (web
// `src/lib/chain.ts` → `{NEXT_PUBLIC_API_URL}/gasless/rpc`). The Pimlico API key stays server-side as a
// secret — the browser never sees it. The method + chain allowlists keep this from becoming an open relay;
// the Pimlico sponsorship policy limits (dashboard) remain the financial backstop against paymaster drain.
app.post("/gasless/rpc", async (c) => {
  const apiKey = c.env.PIMLICO_API_KEY;
  if (!apiKey) return c.json({ error: { code: "not_configured", message: "Pimlico proxy not configured" } }, 503);

  const chain = Number(c.req.query("chain"));
  if (!PIMLICO_CHAINS.has(chain)) {
    return c.json({ error: { code: "unsupported_chain", message: "chain not allowed" } }, 400);
  }

  const body = (await c.req.json().catch(() => null)) as { method?: string; id?: unknown; params?: unknown } | null;
  if (!body || typeof body.method !== "string") {
    return c.json({ error: { code: "bad_request", message: "JSON-RPC body required" } }, 400);
  }
  if (!PIMLICO_METHODS.has(body.method)) {
    return c.json({ error: { code: "method_not_allowed", message: `method ${body.method} not proxied` } }, 403);
  }

  const upstream = new URL(`https://api.pimlico.io/v2/${chain}/rpc`);
  upstream.searchParams.set("apikey", apiKey);
  // Stamp OUR sponsorship policy server-side, overriding whatever the client sent. The dashboard's spend
  // limits are the real guard against paymaster drain, and a policy the caller can omit isn't a guard at
  // all — see gasless.ts. Unset → passthrough (no behaviour change).
  const res = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withSponsorshipPolicy(body, c.env.PIMLICO_SPONSORSHIP_POLICY_ID)),
  });
  // Return the raw JSON-RPC envelope (Pimlico's error shapes are JSON-RPC, not the API's {error}) so the
  // permissionless/viem client can parse status codes and error codes the way it expects.
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
});

app.all("*", async (c) => {
  // No real engine yet? Serve the in-repo mock so the frontend can integrate (see mock.ts).
  // The moment ENGINE is bound (prod) or MOCK isn't "true", we go back to a pure proxy.
  if (!c.env.ENGINE && c.env.MOCK === "true") {
    return mockApp.fetch(c.req.raw, c.env);
  }
  const url = new URL(c.req.url);
  const method = c.req.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();

  // Forward the client's headers, minus hop-by-hop ones the runtime must own itself.
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.delete("accept-encoding"); // let the runtime negotiate; avoids double-encoded bodies

  const upstream = c.env.ENGINE
    // PROD: private service binding — the engine needs no public route.
    ? await c.env.ENGINE.fetch(new Request(url.toString(), { method, headers, body }))
    // DEV: the engine's local dev server.
    : await fetch((c.env.ENGINE_URL || "http://127.0.0.1:8788") + url.pathname + url.search, { method, headers, body });

  // Re-wrap so we don't pass through a stale Content-Encoding/Length for an already-decoded body.
  const out = new Headers(upstream.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
});

export default app;
