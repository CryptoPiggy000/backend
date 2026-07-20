// Meta-aggregator: query multiple DEX aggregators in parallel and return the BEST fill. Every provider
// uses an approve-and-call flow (no signature), so each result drops straight into the app's SWAP Action
// and SmartInvestmentAccount._swap (approve `router`, relay `routeData`, contract enforces
// balance-delta >= minOut). Providers that fail (auth, no liquidity, error) are dropped — one provider
// being down never breaks quoting. Adding an aggregator = one more `quoteX()` in `PROVIDERS`.

export interface AggregatorEnv {
  ZEROX_API_KEY?: string; // 0x Swap API v2 (AllowanceHolder) — a secret
  KYBER_CLIENT_ID?: string; // KyberSwap client id (rate-limit identifier; not secret)
}

export interface QuoteParams {
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string; // base units (wei)
  taker: string; // the account that approves + calls + receives the output
  slippageBps: number;
}

export interface AggQuote {
  provider: string;
  router: string; // approve + call target (must be routeApproved in the ProtocolRegistry)
  routeData: string; // opaque calldata the account relays
  minOut: string; // minimum received (wei) — the contract's balance-delta floor
  buyAmount: string; // expected output (wei) — used to rank providers
}

// A contract-level floor derived from a provider's expected output (belt-and-suspenders on top of the
// provider's own internal min): buyAmount * (1 - slippage).
const floorFromBuy = (buyAmount: string, slippageBps: number): string =>
  ((BigInt(buyAmount) * BigInt(10_000 - slippageBps)) / 10_000n).toString();

// --- 0x Swap API v2 · AllowanceHolder (approve + call; NOT Permit2, so no signature needed) ---
async function quote0x(env: AggregatorEnv, p: QuoteParams): Promise<AggQuote | null> {
  if (!env.ZEROX_API_KEY) return null;
  const u = new URL("https://api.0x.org/swap/allowance-holder/quote");
  u.searchParams.set("chainId", String(p.chainId));
  u.searchParams.set("sellToken", p.sellToken);
  u.searchParams.set("buyToken", p.buyToken);
  u.searchParams.set("sellAmount", p.sellAmount);
  u.searchParams.set("taker", p.taker);
  u.searchParams.set("slippageBps", String(p.slippageBps));
  const res = await fetch(u, { headers: { "0x-api-key": env.ZEROX_API_KEY, "0x-version": "v2" } });
  if (!res.ok) return null;
  const q = (await res.json()) as {
    liquidityAvailable?: boolean;
    buyAmount?: string;
    minBuyAmount?: string;
    transaction?: { to: string; data: string; value: string };
  };
  // value must be 0 (the account relays with no native value); AllowanceHolder → approve target == to.
  if (!q.liquidityAvailable || !q.transaction || q.transaction.value !== "0" || !q.minBuyAmount || !q.buyAmount) {
    return null;
  }
  return { provider: "0x", router: q.transaction.to, routeData: q.transaction.data, minOut: q.minBuyAmount, buyAmount: q.buyAmount };
}

// --- KyberSwap Aggregator API v1 (routes → build; approve + call) ---
const KYBER_CHAIN: Record<number, string> = { 8453: "base" };
async function quoteKyber(env: AggregatorEnv, p: QuoteParams): Promise<AggQuote | null> {
  const chain = KYBER_CHAIN[p.chainId];
  if (!chain) return null;
  const base = `https://aggregator-api.kyberswap.com/${chain}/api/v1`;
  const headers = { "X-Client-Id": env.KYBER_CLIENT_ID || "cryptopiggy", "User-Agent": "cryptopiggy-backend" };
  const rr = await fetch(`${base}/routes?tokenIn=${p.sellToken}&tokenOut=${p.buyToken}&amountIn=${p.sellAmount}`, { headers });
  if (!rr.ok) return null;
  const routes = (await rr.json()) as { data?: { routeSummary?: unknown; routerAddress?: string } };
  if (!routes.data?.routeSummary || !routes.data.routerAddress) return null;
  const br = await fetch(`${base}/route/build`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      routeSummary: routes.data.routeSummary,
      sender: p.taker,
      recipient: p.taker,
      slippageTolerance: p.slippageBps,
      deadline: Math.floor(Date.now() / 1000) + 1200,
    }),
  });
  if (!br.ok) return null;
  const built = (await br.json()) as { data?: { data?: string; routerAddress?: string; amountOut?: string } };
  if (!built.data?.data || !built.data.routerAddress || !built.data.amountOut) return null;
  return {
    provider: "kyberswap",
    router: built.data.routerAddress,
    routeData: built.data.data,
    minOut: floorFromBuy(built.data.amountOut, p.slippageBps),
    buyAmount: built.data.amountOut,
  };
}

const PROVIDERS = [quote0x, quoteKyber];

// The best fill across all providers. Runs them in parallel, drops failures, picks the max output.
export async function bestQuote(env: AggregatorEnv, p: QuoteParams): Promise<{ best: AggQuote; all: AggQuote[] } | null> {
  const settled = await Promise.allSettled(PROVIDERS.map((q) => q(env, p)));
  const all = settled.flatMap((s) => (s.status === "fulfilled" && s.value ? [s.value] : []));
  if (all.length === 0) return null;
  const best = all.reduce((a, b) => (BigInt(b.buyAmount) > BigInt(a.buyAmount) ? b : a));
  return { best, all };
}
