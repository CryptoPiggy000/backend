// Client for the private engine's PLANNER (POST /plan). The engine is SUGGESTION-ONLY (per web/API.md):
// the backend asks it for allocations and maps them into the app's shapes; the engine never moves funds.
// The engine is two workers — this only talks to the planner (the indexer serves the dashboard, not the app).

export interface PlannerEnv {
  PLANNER_URL?: string; // DEV: the planner's wrangler dev URL (e.g. http://127.0.0.1:8791)
  PLANNER?: Fetcher; // PROD: private service binding to cryptopiggy-planner
}

const VALID_TERMS = ["1m", "3m", "6m", "1y"];
export const asTerm = (t: unknown): string => (VALID_TERMS.includes(t as string) ? (t as string) : "1y");

// The 3 chooser presets → engine risk dial. Green (all savings) → red (~50% crypto).
export const PRESETS = [
  { id: "safe", label: "Safe", risk: 0.1 },
  { id: "balanced", label: "Balanced", risk: 0.5 },
  { id: "bold", label: "Bold", risk: 0.9 },
];
export const PRESET_RISK: Record<string, number> = Object.fromEntries(PRESETS.map((p) => [p.id, p.risk]));

// The mix is amount-independent, so the strategies are computed at a nominal $1,000. `address` is
// identity-only for the engine (it does no chain reads), so a placeholder is fine.
const NOMINAL_ADDR = "0x0000000000000000000000000000000000000001";
export const NOMINAL_TOWORK = "1000000000"; // $1,000 in USDC base units (6-dec)

interface PlanBody {
  address?: string;
  toWork: string;
  risk: number;
  term: string;
  holdings?: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callPlanner(env: PlannerEnv, body: PlanBody): Promise<any> {
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    // address AFTER the spread + `||` so a caller passing `address: undefined` still gets the placeholder
    // (the planner 400s on a missing address — it's identity-only, so a placeholder is fine).
    body: JSON.stringify({ ...body, address: body.address || NOMINAL_ADDR }),
  };
  const res = env.PLANNER
    ? await env.PLANNER.fetch(new Request("http://planner/plan", init))
    : await fetch((env.PLANNER_URL || "http://127.0.0.1:8791") + "/plan", init);
  if (!res.ok) throw new Error(`planner responded ${res.status}`);
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const blend = (alloc: any[], pick: (a: any) => number) =>
  alloc.length ? Math.round(alloc.reduce((sum, a) => sum + a.pct * pick(a), 0) / 100) : 0;

// Map an engine plan → the chooser strategy shape the frontend consumes: the savings/crypto split, the
// steady yield, the expected return + downside/upside range over the term, and the per-venue mix (named).
export function toStrategy(
  preset: { id: string; label: string; risk: number },
  term: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plan: any,
) {
  const alloc = plan.allocation ?? [];
  const s = plan.summary ?? {};
  return {
    id: preset.id,
    label: preset.label,
    risk: preset.risk,
    term,
    savingsPct: s.savingsPct ?? 0,
    cryptoPct: s.cryptoPct ?? 0,
    apyBps: s.blendedYieldBps ?? 0, // steady savings yield
    expectedReturnBps: blend(alloc, (a) => a.expected_return_bps), // overall, over the term
    downsideBps: blend(alloc, (a) => a.downside_bps),
    upsideBps: blend(alloc, (a) => a.upside_bps),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mix: alloc.map((a: any) => ({
      key: a.position_id,
      symbol: a.symbol,
      name: a.symbol,
      class: a.class, // "savings" | "crypto"
      pct: a.pct,
      apyBps: a.apy_bps,
      expectedReturnBps: a.expected_return_bps,
      downsideBps: a.downside_bps,
      upsideBps: a.upside_bps,
    })),
  };
}
