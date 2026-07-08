// The public Worker. Non-custodial by construction: it holds no key, no store, no chain access —
// it only adds CORS and forwards every request to the private engine, which does the real work.
import { Hono } from "hono";
import { cors } from "hono/cors";

interface Env {
  ENGINE_URL: string;   // DEV: engine's wrangler dev URL
  ENGINE?: Fetcher;     // PROD: private service binding (keeps the engine off the public internet)
  CORS_ORIGIN: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", (c, next) => cors({ origin: c.env.CORS_ORIGIN || "*" })(c, next));

app.all("*", async (c) => {
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
