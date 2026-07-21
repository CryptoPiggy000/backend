import { createPublicClient, http, type Abi, type AbiEvent, type Address, type Hex, type PublicClient, zeroAddress } from "viem";
import { ADAPTER, aavePoolAbi, chainlinkAbi, erc20Abi, erc4626Abi, registryAbi } from "./abi";

const ZERO = zeroAddress;

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

export function makeClient(rpc: string): PublicClient {
  return createPublicClient({ transport: http(rpc) });
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

async function read<T>(client: PublicClient, address: Address, abi: Abi, fn: string, args: unknown[] = []): Promise<T> {
  return client.readContract({ address, abi, functionName: fn, args }) as Promise<T>;
}

export async function readDecimals(client: PublicClient, token: Address, cache: Map<string, number>): Promise<number> {
  const k = token.toLowerCase();
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const d = Number(await read<bigint>(client, token, erc20Abi, "decimals"));
  cache.set(k, d);
  return d;
}

async function balanceOf(client: PublicClient, token: Address, account: Address): Promise<bigint> {
  try {
    return await read<bigint>(client, token, erc20Abi, "balanceOf", [account]);
  } catch {
    return 0n; // a missing/incompatible token contributes nothing rather than failing the pass
  }
}

/** Held-asset USD price as an 8dp integer. Override (dev) wins; else the Chainlink feed; else 0 (skip). */
async function priceUsd8(client: PublicClient, token: Address, cfg: OpsConfig): Promise<bigint> {
  const k = token.toLowerCase();
  if (cfg.priceOverrides[k] != null) return BigInt(Math.round(cfg.priceOverrides[k] * 1e8));
  const feed = cfg.chainlink[k];
  if (!feed) return 0n;
  try {
    const [, answer] = await read<[bigint, bigint, bigint, bigint, bigint]>(
      client, feed as Address, chainlinkAbi, "latestRoundData",
    );
    const fdec = Number(await read<bigint>(client, feed as Address, chainlinkAbi, "decimals"));
    if (answer <= 0n) return 0n;
    return fdec === 8 ? answer : fdec > 8 ? answer / 10n ** BigInt(fdec - 8) : answer * 10n ** BigInt(8 - fdec);
  } catch {
    return 0n;
  }
}

/** The account's Aave position value: aToken balance on Base (accrues), else the mock pool's supplied(). */
async function aaveValue(client: PublicClient, pool: Address, asset: Address, account: Address, cfg: OpsConfig): Promise<bigint> {
  const aToken = cfg.aTokens[`${pool.toLowerCase()}:${asset.toLowerCase()}`];
  if (aToken) return balanceOf(client, aToken as Address, account);
  try {
    return await read<bigint>(client, pool, aavePoolAbi, "supplied", [account, asset]);
  } catch {
    return 0n;
  }
}

export interface Position {
  adapter: number;
  target: Address;
  asset: Address;
}

export async function enumeratePositions(client: PublicClient, registry: Address): Promise<Position[]> {
  const ids = await read<Hex[]>(client, registry, registryAbi, "allPositionIds");
  const out: Position[] = [];
  for (const id of ids) {
    const p = await read<{ adapterType: number; target: Address; asset: Address }>(
      client, registry, registryAbi, "getProtocol", [id],
    );
    out.push({ adapter: Number(p.adapterType), target: p.target, asset: p.asset });
  }
  return out;
}

export async function readBaseAsset(client: PublicClient, registry: Address): Promise<Address> {
  return read<Address>(client, registry, registryAbi, "baseAsset");
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
): Promise<PositionValue[]> {
  const out: PositionValue[] = [];

  for (const p of positions) {
    if (p.adapter === ADAPTER.AAVE) {
      const raw = await aaveValue(client, p.target, p.asset, account, cfg);
      const v = usd6(raw, await readDecimals(client, p.asset, decCache));
      if (v > 0n) out.push({ key: p.target.toLowerCase(), name: "Aave", class: "savings", value6: v });
    } else if (p.adapter === ADAPTER.ERC4626) {
      const shares = await balanceOf(client, p.target, account);
      if (shares === 0n) continue;
      const assets = await read<bigint>(client, p.target, erc4626Abi, "convertToAssets", [shares]);
      const v = usd6(assets, await readDecimals(client, p.asset, decCache));
      if (v > 0n) {
        out.push({ key: p.target.toLowerCase(), name: await symbolOf(client, p.target, symCache), class: "savings", value6: v });
      }
    }
  }

  for (const token of cfg.heldAssets) {
    const raw = await balanceOf(client, token, account);
    if (raw === 0n) continue;
    const price8 = await priceUsd8(client, token, cfg);
    if (price8 === 0n) continue;
    const v = usd6(raw, await readDecimals(client, token, decCache), price8);
    if (v > 0n) {
      out.push({ key: token.toLowerCase(), name: await symbolOf(client, token, symCache), class: "crypto", value6: v });
    }
  }

  return out;
}

/** Live portfolio value of one account, in µUSD: idle base asset + Aave + vaults + held×price. */
export async function accountValueUsd6(
  client: PublicClient,
  account: Address,
  cfg: OpsConfig,
  positions: Position[],
  base: Address,
  decCache: Map<string, number>,
): Promise<bigint> {
  let total = 0n;

  // idle base asset (USDC assumed $1); skip if the registry has no base asset wired yet
  if (base && base !== ZERO) {
    const baseDec = await readDecimals(client, base, decCache);
    total += usd6(await balanceOf(client, base, account), baseDec);
  }

  // protocol positions
  for (const p of positions) {
    if (p.adapter === ADAPTER.AAVE) {
      const raw = await aaveValue(client, p.target, p.asset, account, cfg);
      total += usd6(raw, await readDecimals(client, p.asset, decCache));
    } else if (p.adapter === ADAPTER.ERC4626) {
      const shares = await balanceOf(client, p.target, account);
      const assets = shares === 0n ? 0n : await read<bigint>(client, p.target, erc4626Abi, "convertToAssets", [shares]);
      total += usd6(assets, await readDecimals(client, p.asset, decCache));
    }
  }

  // held assets (config-supplied set; priced via Chainlink / override)
  for (const token of cfg.heldAssets) {
    const raw = await balanceOf(client, token, account);
    if (raw === 0n) continue;
    const price8 = await priceUsd8(client, token, cfg);
    if (price8 === 0n) continue; // unknown price → skip rather than mis-value or crash
    total += usd6(raw, await readDecimals(client, token, decCache), price8);
  }

  return total;
}
