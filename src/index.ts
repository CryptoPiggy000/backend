// The public Worker. Non-custodial by construction: it holds no key, no store, no chain access —
// it only adds CORS and forwards every request to the private engine, which does the real work.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { mockApp } from "./mock";
import { callPlanner, toStrategy, asTerm, PRESETS, PRESET_RISK, NOMINAL_TOWORK } from "./engine";

interface Env {
  ENGINE_URL: string;   // DEV: engine's wrangler dev URL
  ENGINE?: Fetcher;     // PROD: private service binding (keeps the engine off the public internet)
  PLANNER_URL?: string; // DEV: the engine PLANNER's wrangler dev URL (the app's /market/* calls it)
  PLANNER?: Fetcher;    // PROD: private service binding to cryptopiggy-planner
  CORS_ORIGIN: string;
  MOCK?: string;        // DEV: "true" → serve the in-repo mock engine (no real engine yet)
}

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
