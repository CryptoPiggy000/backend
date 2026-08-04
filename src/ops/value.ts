import type { Address, PublicClient } from "viem";
import {
  accountPositionsUsd6,
  accountValueUsd6,
  enumeratePositions,
  type OpsConfig,
  readBaseAsset,
} from "./chain";
import type { Store } from "./store";

export interface ValueResult {
  accounts: number;
  block: number;
}

/**
 * The slower pass: for every known account, snapshot its CURRENT on-chain value — total (idle base
 * asset + Aave + vaults + held×price) and DEPLOYED (positions only, no idle) — to ops_account_value /
 * ops_account_deployed. Reads ground truth each cycle rather than reconstructing holdings from events.
 *
 * The reads happen at the INDEX CURSOR block (the last block the log-index has fully processed), not
 * at head. That keeps `deployed` consistent with the flows' cost basis (principal): a deposit lands in
 * BOTH at the same time, so `/account`'s `accrued = deployed − principal` can never show a just-arrived
 * deposit as fake interest (the chain is ahead of the indexer for up to an index interval — mixing a
 * fresh chain read with the indexed cost basis was the "$1.9 then $0" spike).
 */
export async function runValuePass(client: PublicClient, store: Store, cfg: OpsConfig): Promise<ValueResult> {
  const accounts = await store.listAccounts();
  if (accounts.length === 0) return { accounts: 0, block: 0 };

  // cursor is deployBlock until the first index pass; read at cursor−1 (the last processed block).
  // undefined → read at head (no index has run yet — anvil/empty).
  const cursor = await store.getCursor(cfg.deployBlock);
  const valueBlock = cursor > cfg.deployBlock ? cursor - 1n : undefined;
  const blk = valueBlock !== undefined ? await client.getBlock({ blockNumber: valueBlock }) : await client.getBlock();
  const block = Number(blk.number);
  const ts = Number(blk.timestamp);

  const base = await readBaseAsset(client, cfg.registry, valueBlock);
  const positions = await enumeratePositions(client, cfg.registry, valueBlock);
  const decCache = new Map<string, number>();

  for (const a of accounts) {
    const addr = a.account as Address;
    const total = await accountValueUsd6(client, addr, cfg, positions, base, decCache, valueBlock);
    const deployed = await accountPositionsUsd6(client, addr, cfg, positions, decCache, new Map(), valueBlock);
    const deployedUsd = deployed.reduce((s, p) => s + p.value6, 0n);
    await store.upsertValue(a.account, total.toString(), block, ts);
    await store.upsertDeployed(a.account, deployedUsd.toString(), block, ts);
  }
  return { accounts: accounts.length, block };
}
