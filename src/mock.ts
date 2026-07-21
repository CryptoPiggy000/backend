// Dev mock "engine": implements the web/API.md shapes in-memory so the frontend can
// integrate NOW, before the real private engine (Vũ) is ready. In prod the backend
// proxies to the real engine and this mock is bypassed (see index.ts: only used when
// no ENGINE binding and MOCK === "true"). State is per dev-process and resets on restart.
import { Hono } from "hono";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const DEMO_SPEED = 8000; // match the frontend sim so behaviour lines up

type Position = { key: string; name: string; base: bigint; apyBps: number };
type Slice = { key: string; name: string; pct: number; apyBps: number };

const STRATEGIES: Record<string, { label: string; mix: Slice[] }> = {
  safe: { label: "Safe", mix: [{ key: "aave", name: "Aave lending", pct: 100, apyBps: 280 }] },
  balanced: {
    label: "Balanced",
    mix: [
      { key: "aave", name: "Aave lending", pct: 50, apyBps: 280 },
      { key: "vault", name: "Stable-yield vault", pct: 50, apyBps: 410 },
    ],
  },
  growth: { label: "Higher yield", mix: [{ key: "vault", name: "Stable-yield vault", pct: 100, apyBps: 410 }] },
};

// Single-user in-memory state (dev only).
const S = {
  owner: "0x1111111111111111111111111111111111111111",
  piggy: "0x2222222222222222222222222222222222222222",
  preference: null as null | { goal: string; riskTolerance: string; horizon: string },
  restingBase: 0n, // USDC in the wallet (Resting)
  harvestedBase: 0n, // collected interest, also in the wallet
  positions: [] as Position[], // Earning principal
  earnSince: null as number | null,
  activity: [] as { id: string; ts: number; type: string; summary: string; txHash?: string }[],
  ops: new Map<string, { kind: string; params: Record<string, string> }>(),
  seq: 0,
};

const now = () => Date.now();
const nid = (p: string) => `${p}_${(++S.seq).toString(36)}${now().toString(36)}`;
const money = (base: bigint) => ({ base: base.toString(), usd: (Number(base) / 1e6).toFixed(2) });
const usd2 = (base: bigint) => `$${(Number(base) / 1e6).toFixed(2)}`;
const txStub = () => "0x" + "ab".repeat(32);

const deployed = () => S.positions.reduce((a, p) => a + p.base, 0n);
const blendedApyBps = () => {
  const d = deployed();
  if (d === 0n) return 0;
  return Math.round(S.positions.reduce((a, p) => a + p.apyBps * Number(p.base), 0) / Number(d));
};
const strategyApyBps = (mix: Slice[]) => Math.round(mix.reduce((a, m) => a + m.pct * m.apyBps, 0) / 100);
const accrued = (t: number) => {
  if (!S.earnSince || S.positions.length === 0) return 0n;
  const years = ((t - S.earnSince) / YEAR_MS) * DEMO_SPEED;
  if (years <= 0) return 0n;
  let total = 0n;
  for (const p of S.positions) total += BigInt(Math.floor(Number(p.base) * (p.apyBps / 10000) * years));
  return total;
};
const realize = (t: number) => {
  S.harvestedBase += accrued(t);
  S.earnSince = S.positions.length ? t : null;
};
const log = (type: string, summary: string) => {
  S.activity.unshift({ id: nid("act"), ts: now(), type, summary, txHash: txStub() });
  S.activity = S.activity.slice(0, 100);
};
const err = (code: string, message: string) => ({ error: { code, message } });

export const mockApp = new Hono();

mockApp.get("/", (c) => c.json({ ok: true, mock: true, service: "cryptopiggy-mock-engine" }));

mockApp.post("/auth/verify", (c) =>
  c.json({
    session: "mock-session",
    expiresAt: now() + 3_600_000,
    user: { id: "usr_mock", owner: S.owner, piggy: S.piggy },
  }),
);

mockApp.get("/me/portfolio", (c) => {
  const t = now();
  const d = deployed();
  const acc = accrued(t);
  const earning = d + acc;
  const resting = S.restingBase + S.harvestedBase;
  return c.json({
    total: money(resting + earning),
    resting: { ...money(resting), pendingBase: "0" },
    earning: money(earning),
    principal: money(d),
    accrued: money(acc),
    apyBps: blendedApyBps(),
    positions: S.positions.map((p) => ({ key: p.key, name: p.name, base: p.base.toString(), apyBps: p.apyBps })),
  });
});

mockApp.get("/me/preference", (c) =>
  c.json(S.preference ?? { goal: null, riskTolerance: null, horizon: null }),
);
mockApp.put("/me/preference", async (c) => {
  S.preference = await c.req.json();
  return c.json(S.preference);
});

mockApp.get("/market/strategies", (c) =>
  c.json({
    strategies: Object.entries(STRATEGIES).map(([id, s]) => ({
      id,
      label: s.label,
      apyBps: strategyApyBps(s.mix),
      mix: s.mix,
    })),
  }),
);

// ---- operations: build → sign → submit ----
const buildOp = (kind: string, params: Record<string, string>, preview: unknown) => {
  const operationId = nid("op");
  S.ops.set(operationId, { kind, params });
  return {
    operationId,
    expiresAt: now() + 300_000,
    preview,
    actions: [], // real engine fills Action[] mirroring contracts/src/Types.sol
    toSign: { type: "userOpHash", value: "0x" + "cd".repeat(32) },
  };
};

mockApp.post("/operations/earn", async (c) => {
  const { amount, strategy } = await c.req.json();
  const amt = BigInt(amount ?? "0");
  const s = STRATEGIES[strategy];
  if (!s) return c.json(err("amount_too_small", "unknown strategy"), 400);
  if (amt <= 0n || amt > S.restingBase) return c.json(err("insufficient_funds", "amount exceeds wallet"), 400);
  const apyBps = strategyApyBps(s.mix);
  return c.json(
    buildOp("earn", { amount, strategy }, {
      kind: "earn",
      amount: money(amt),
      mix: s.mix.map((m) => ({ name: m.name, pct: m.pct, apyBps: m.apyBps })),
      estYearlyBase: ((amt * BigInt(apyBps)) / 10_000n).toString(),
      feeBase: "0",
    }),
  );
});

mockApp.post("/operations/harvest", (c) => {
  const gross = accrued(now());
  return c.json(
    buildOp("harvest", {}, {
      kind: "harvest",
      grossBase: gross.toString(),
      netBase: gross.toString(), // harvest is free — the fee is on deposits only
    }),
  );
});

mockApp.post("/operations/exit", async (c) => {
  const { amount } = await c.req.json();
  const amt = BigInt(amount ?? "0");
  if (amt <= 0n || amt > deployed()) return c.json(err("insufficient_funds", "amount exceeds earning"), 400);
  return c.json(
    buildOp("exit", { amount }, { kind: "exit", amount: money(amt), settlesInstantly: false, etaSeconds: 60 }),
  );
});

mockApp.post("/operations/withdraw", async (c) => {
  const { to, amount } = await c.req.json();
  const amt = BigInt(amount ?? "0");
  if (amt <= 0n || amt > S.restingBase + S.harvestedBase)
    return c.json(err("insufficient_funds", "amount exceeds wallet"), 400);
  return c.json(
    buildOp("withdraw", { to, amount }, { kind: "withdraw", amount: money(amt), to, feeBase: "0" }),
  );
});

mockApp.post("/operations/:id/submit", (c) => {
  const op = S.ops.get(c.req.param("id"));
  if (!op) return c.json(err("operation_expired", "unknown operation"), 400);
  const t = now();
  if (op.kind === "earn") {
    realize(t);
    const amt = BigInt(op.params.amount);
    S.restingBase -= amt;
    for (const m of STRATEGIES[op.params.strategy].mix) {
      const part = (amt * BigInt(m.pct)) / 100n;
      const ex = S.positions.find((p) => p.key === m.key);
      if (ex) ex.base += part;
      else S.positions.push({ key: m.key, name: m.name, base: part, apyBps: m.apyBps });
    }
    S.earnSince = t;
    log("earn", `Put ${usd2(amt)} to work`);
  } else if (op.kind === "harvest") {
    const net = accrued(t); // harvest is free — the fee is on deposits only
    S.harvestedBase += net;
    S.earnSince = S.positions.length ? t : null;
    log("harvest", `Harvested ${usd2(net)}`);
  } else if (op.kind === "exit") {
    realize(t);
    const d = deployed();
    const amt = BigInt(op.params.amount);
    const cut = amt >= d ? d : amt;
    const remaining = d - cut;
    S.positions =
      remaining === 0n
        ? []
        : S.positions.map((p) => ({ ...p, base: (p.base * remaining) / d })).filter((p) => p.base > 0n);
    S.restingBase += cut;
    S.earnSince = S.positions.length ? t : null;
    log("exit", `Closed ${usd2(cut)} to wallet`);
  } else if (op.kind === "withdraw") {
    const amt = BigInt(op.params.amount);
    const fromResting = amt > S.restingBase ? S.restingBase : amt;
    S.restingBase -= fromResting;
    S.harvestedBase -= amt - fromResting;
    log("withdraw", `Withdrew ${usd2(amt)} to ${String(op.params.to).slice(0, 6)}…`);
  }
  S.ops.delete(c.req.param("id"));
  return c.json({ status: "confirmed", txHash: txStub(), confirmedAt: t });
});

mockApp.get("/operations/:id", (c) =>
  c.json({ status: "confirmed", txHash: txStub(), confirmedAt: now() }),
);

// ---- fiat on-ramp: mock delivers USDC to the wallet instantly ----
mockApp.post("/onramp/session", async (c) => {
  const { amountUsd } = await c.req.json();
  const base = BigInt(Math.round(Number(amountUsd ?? "0") * 1e6));
  S.restingBase += base;
  log("onramp", `Added $${Number(amountUsd ?? 0).toFixed(2)} via card (mock)`);
  const sessionId = nid("os");
  return c.json({
    sessionId,
    checkoutUrl: `https://mock.onramp.local/checkout/${sessionId}`,
    destination: S.piggy,
    provider: "mock",
    quote: { minUsd: "10.00", maxUsd: "2000.00", feeUsd: "0.00", estUsdcBase: base.toString() },
  });
});
mockApp.get("/onramp/session/:id", (c) =>
  c.json({ status: "completed", usdcBase: "0", txHash: txStub() }),
);

mockApp.get("/me/activity", (c) => c.json({ items: S.activity }));

mockApp.all("*", (c) => c.json(err("not_found", "no such mock route"), 404));
