import { createPublicClient, custom, http, type Abi, type AbiEvent, type Address, type Hex, type PublicClient, zeroAddress } from "viem";
import { ADAPTER, aavePoolAbi, chainlinkAbi, erc20Abi, erc4626Abi, registryAbi } from "./abi";

const ZERO = zeroAddress;

// The provider caps requests per second (zan.top = 20 RPS / CU-limited). The passes fire many reads
// back-to-back, so we SERIALIZE every JSON-RPC call through one queue and space consecutive calls by
// `1000/MAX_RPS` ms. MAX_RPS is set below the provider cap for headroom. This is the hard guarantee;
// non-overlapping crons (wrangler.ops.toml) keep two passes from doubling it across worker instances.
const MAX_RPS = 12;

function throttledTransport(rpc: string, bearer?: string) {
  // Blockmachine (and other keyed endpoints) authenticate via `Authorization: Bearer`, not a key in the
  // URL — pass it through fetchOptions so the key never lands in a logged/committed URL.
  const opts = bearer ? { fetchOptions: { headers: { Authorization: `Bearer ${bearer}` } } } : {};
  const inner = http(rpc, opts)({}); // instantiate the underlying HTTP transport
  const minGapMs = Math.ceil(1000 / MAX_RPS);
  let last = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return custom({
    request(args) {
      const turn = queue.then(async () => {
        const wait = last + minGapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
      });
      queue = turn.catch(() => {});
      return turn.then(() => inner.request(args));
    },
  });
}

export interface OpsConfig {
  registry: Address;
  factory: Address;
  deployBlock: bigint;
  confirmations: bigint;
  range: bigint;
  aTokens: Record<string, string>; // "<pool>:<asset>" (lowercased) → aToken address (Base)
  chainlink: Record<string, string>; // token (lowercased) → USD feed
  priceOverrides: Record<string, number>; // token (lowercased) → USD price (dev/anvil)
  heldAssets: Address[]; // held-asset tokens to value (registry can't enumerate assets)
}

export function makeClient(rpc: string, bearer?: string): PublicClient {
  return createPublicClient({ transport: throttledTransport(rpc, bearer) });
}

/**
 * A client for the bursty live per-account reads (Blockmachine). No RPS throttle — the provider
 * absorbs the concurrency — and `batch: true` so viem bundles the many small reads issued in one tick
 * into a single JSON-RPC batch request, collapsing ~20 serial round-trips into ~1 (the /account latency
 * fix). `bearer`, if set, authenticates via an Authorization header rather than a key in the URL.
 */
export function makeReadClient(rpc: string, bearer?: string): PublicClient {
  const http_ = bearer
    ? http(rpc, { batch: true, fetchOptions: { headers: { Authorization: `Bearer ${bearer}` } } })
    : http(rpc, { batch: true });
  return createPublicClient({ transport: http_ });
}

/** Canonical money: a token `raw` amount (its own `dec` decimals) priced at `price8` (8dp USD) → µUSD (6dp). */
export function usd6(raw: bigint, dec: number, price8: bigint = 100_000_000n): bigint {
  return (raw * price8 * 1_000_000n) / (10n ** BigInt(dec) * 100_000_000n);
}

export interface DecodedLog {
  args: Record<string, unknown>;
  address: string; // the emitting contract (for clone events, this IS the account)
  blockNumber: bigint | null;
  transactionHash: string | null;
  logIndex: number | null;
}

export interface NamedLog extends DecodedLog {
  eventName: string;
}

/** eth_getLogs for one event, walked in ≤`range` windows (public-RPC range limit). `address` may be a
 *  single contract, a set, or undefined (topic-only across all addresses — for clone events like the fee,
 *  emitted by many per-user accounts). Passing `event` makes viem decode `args`. */
export async function getEventLogs(
  client: PublicClient,
  address: Address | Address[] | undefined,
  event: AbiEvent,
  fromBlock: bigint,
  toBlock: bigint,
  range: bigint,
): Promise<DecodedLog[]> {
  const out: DecodedLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += range) {
    let end = start + range - 1n;
    if (end > toBlock) end = toBlock;
    const filter = address
      ? { address, event, fromBlock: start, toBlock: end }
      : { event, fromBlock: start, toBlock: end };
    const logs = await client.getLogs(filter);
    out.push(...(logs as unknown as DecodedLog[]));
  }
  return out;
}

/** eth_getLogs for MANY events on one address in a single call per window; each log carries `eventName`
 *  so a generic audit indexer can route by type. Used for the registry's governance/admin events. */
export async function getMultiEventLogs(
  client: PublicClient,
  address: Address,
  events: AbiEvent[],
  fromBlock: bigint,
  toBlock: bigint,
  range: bigint,
): Promise<NamedLog[]> {
  const out: NamedLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += range) {
    let end = start + range - 1n;
    if (end > toBlock) end = toBlock;
    const logs = await client.getLogs({ address, events, fromBlock: start, toBlock: end });
    out.push(...(logs as unknown as NamedLog[]));
  }
  return out;
}

/** Timestamps for a set of blocks (unique, cached per call). */
export async function blockTimestamps(client: PublicClient, blocks: bigint[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (const b of [...new Set(blocks.map(String))]) {
    const blk = await client.getBlock({ blockNumber: BigInt(b) });
    m.set(b, Number(blk.timestamp));
  }
  return m;
}

async function read<T>(client: PublicClient, address: Address, abi: Abi, fn: string, args: unknown[] = [], blockNumber?: bigint): Promise<T> {
  return client.readContract({ address, abi, functionName: fn, args, ...(blockNumber !== undefined ? { blockNumber } : {}) }) as Promise<T>;
}

export async function readDecimals(client: PublicClient, token: Address, cache: Map<string, number>): Promise<number> {
  const k = token.toLowerCase();
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const d = Number(await read<bigint>(client, token, erc20Abi, "decimals"));
  cache.set(k, d);
  return d;
}

async function balanceOf(client: PublicClient, token: Address, account: Address, blockNumber?: bigint): Promise<bigint> {
  try {
    return await read<bigint>(client, token, erc20Abi, "balanceOf", [account], blockNumber);
  } catch {
    return 0n; // a missing/incompatible token contributes nothing rather than failing the pass
  }
}

/** Held-asset USD price as an 8dp integer. Override (dev) wins; else the Chainlink feed; else 0 (skip). */
async function priceUsd8(client: PublicClient, token: Address, cfg: OpsConfig, blockNumber?: bigint): Promise<bigint> {
  const k = token.toLowerCase();
  if (cfg.priceOverrides[k] != null) return BigInt(Math.round(cfg.priceOverrides[k] * 1e8));
  const feed = cfg.chainlink[k];
  if (!feed) return 0n;
  try {
    const [, answer] = await read<[bigint, bigint, bigint, bigint, bigint]>(
      client, feed as Address, chainlinkAbi, "latestRoundData", [], blockNumber,
    );
    const fdec = Number(await read<bigint>(client, feed as Address, chainlinkAbi, "decimals"));
    if (answer <= 0n) return 0n;
    return fdec === 8 ? answer : fdec > 8 ? answer / 10n ** BigInt(fdec - 8) : answer * 10n ** BigInt(8 - fdec);
  } catch {
    return 0n;
  }
}

/** The account's Aave position value: aToken balance on Base (accrues), else the mock pool's supplied(). */
async function aaveValue(client: PublicClient, pool: Address, asset: Address, account: Address, cfg: OpsConfig, blockNumber?: bigint): Promise<bigint> {
  const aToken = cfg.aTokens[`${pool.toLowerCase()}:${asset.toLowerCase()}`];
  if (aToken) return balanceOf(client, aToken as Address, account, blockNumber);
  try {
    return await read<bigint>(client, pool, aavePoolAbi, "supplied", [account, asset], blockNumber);
  } catch {
    return 0n;
  }
}

export interface Position {
  adapter: number;
  target: Address;
  asset: Address;
}

export async function enumeratePositions(client: PublicClient, registry: Address, blockNumber?: bigint): Promise<Position[]> {
  const ids = await read<Hex[]>(client, registry, registryAbi, "allPositionIds", [], blockNumber);
  // Fetch every protocol together (order preserved) so a batching transport collapses the getProtocol
  // reads into one round-trip instead of one serial round-trip per venue.
  const protos = await Promise.all(
    ids.map((id) =>
      read<{ adapterType: number; target: Address; asset: Address }>(client, registry, registryAbi, "getProtocol", [id], blockNumber),
    ),
  );
  return protos.map((p) => ({ adapter: Number(p.adapterType), target: p.target, asset: p.asset }));
}

export async function readBaseAsset(client: PublicClient, registry: Address, blockNumber?: bigint): Promise<Address> {
  return read<Address>(client, registry, registryAbi, "baseAsset", [], blockNumber);
}

/** The current deposit fee straight from the registry — the live source of truth for `/stats`. */
export async function readDepositFee(client: PublicClient, registry: Address): Promise<{ bps: number; collector: string }> {
  const [bps, collector] = await read<[number, Address]>(client, registry, registryAbi, "depositFee");
  return { bps: Number(bps), collector };
}

async function symbolOf(client: PublicClient, token: Address, cache: Map<string, string>): Promise<string> {
  const k = token.toLowerCase();
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  let sym = `${token.slice(0, 6)}…`;
  try {
    sym = await read<string>(client, token, erc20Abi, "symbol");
  } catch {
    /* non-standard token → fall back to a short address */
  }
  cache.set(k, sym);
  return sym;
}

export interface PositionValue {
  key: string; // the venue's on-chain address (lowercased)
  name: string; // display symbol (vault/token) or "Aave"
  class: "savings" | "crypto";
  value6: bigint; // current µUSD value of this position for the account
}

/**
 * The per-venue breakdown behind `accountValueUsd6` — one entry per non-zero holding (Aave / vaults /
 * held assets). Same reads as the total; we just keep the split. Idle base asset is NOT a position.
 * APY isn't known here (it lives in the engine's market analysis) — the client enriches that.
 */
export async function accountPositionsUsd6(
  client: PublicClient,
  account: Address,
  cfg: OpsConfig,
  positions: Position[],
  decCache: Map<string, number>,
  symCache: Map<string, string>,
  blockNumber?: bigint,
): Promise<PositionValue[]> {
  // Each position / held asset resolves to a PositionValue or null. We run them concurrently and fire
  // each one's independent sub-reads (balance, decimals, symbol, price) together so a batching transport
  // (makeReadClient) collapses them into ~1 round-trip. Order is preserved — positions, then held assets.
  const positionTask = async (p: Position): Promise<PositionValue | null> => {
    if (p.adapter === ADAPTER.AAVE) {
      const [raw, dec] = await Promise.all([
        aaveValue(client, p.target, p.asset, account, cfg, blockNumber),
        readDecimals(client, p.asset, decCache),
      ]);
      const v = usd6(raw, dec);
      return v > 0n ? { key: p.target.toLowerCase(), name: "Aave", class: "savings", value6: v } : null;
    }
    if (p.adapter === ADAPTER.ERC4626) {
      const shares = await balanceOf(client, p.target, account, blockNumber);
      if (shares === 0n) return null; // convertToAssets depends on shares — no read to make
      const [assets, dec, name] = await Promise.all([
        read<bigint>(client, p.target, erc4626Abi, "convertToAssets", [shares], blockNumber),
        readDecimals(client, p.asset, decCache),
        symbolOf(client, p.target, symCache),
      ]);
      const v = usd6(assets, dec);
      return v > 0n ? { key: p.target.toLowerCase(), name, class: "savings", value6: v } : null;
    }
    return null;
  };

  const heldTask = async (token: Address): Promise<PositionValue | null> => {
    const [raw, price8, dec, name] = await Promise.all([
      balanceOf(client, token, account, blockNumber),
      priceUsd8(client, token, cfg, blockNumber),
      readDecimals(client, token, decCache),
      symbolOf(client, token, symCache),
    ]);
    if (raw === 0n || price8 === 0n) return null; // no holding, or no known price → not a position
    const v = usd6(raw, dec, price8);
    return v > 0n ? { key: token.toLowerCase(), name, class: "crypto", value6: v } : null;
  };

  const resolved = await Promise.all([
    ...positions.map(positionTask),
    ...cfg.heldAssets.map(heldTask),
  ]);
  return resolved.filter((x): x is PositionValue => x !== null);
}

/** Live portfolio value of one account, in µUSD: idle base asset + Aave + vaults + held×price. */
export async function accountValueUsd6(
  client: PublicClient,
  account: Address,
  cfg: OpsConfig,
  positions: Position[],
  base: Address,
  decCache: Map<string, number>,
  blockNumber?: bigint,
): Promise<bigint> {
  let total = 0n;

  // idle base asset (USDC assumed $1); skip if the registry has no base asset wired yet
  if (base && base !== ZERO) {
    const baseDec = await readDecimals(client, base, decCache);
    total += usd6(await balanceOf(client, base, account, blockNumber), baseDec);
  }

  // protocol positions
  for (const p of positions) {
    if (p.adapter === ADAPTER.AAVE) {
      const raw = await aaveValue(client, p.target, p.asset, account, cfg, blockNumber);
      total += usd6(raw, await readDecimals(client, p.asset, decCache));
    } else if (p.adapter === ADAPTER.ERC4626) {
      const shares = await balanceOf(client, p.target, account, blockNumber);
      const assets = shares === 0n ? 0n : await read<bigint>(client, p.target, erc4626Abi, "convertToAssets", [shares], blockNumber);
      total += usd6(assets, await readDecimals(client, p.asset, decCache));
    }
  }

  // held assets (config-supplied set; priced via Chainlink / override)
  for (const token of cfg.heldAssets) {
    const raw = await balanceOf(client, token, account, blockNumber);
    if (raw === 0n) continue;
    const price8 = await priceUsd8(client, token, cfg, blockNumber);
    if (price8 === 0n) continue; // unknown price → skip rather than mis-value or crash
    total += usd6(raw, await readDecimals(client, token, decCache), price8);
  }

  return total;
}
