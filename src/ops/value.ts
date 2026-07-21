import type { Address, PublicClient } from "viem";
import { accountValueUsd6, enumeratePositions, type OpsConfig, readBaseAsset } from "./chain";
import type { Store } from "./store";

export interface ValueResult {
  accounts: number;
  block: number;
}

/**
 * The slower pass: for every known account, read its CURRENT on-chain value (idle base asset + Aave +
 * vaults + held×price) and snapshot it to ops_account_value. Reads ground truth each cycle rather than
 * reconstructing holdings from events — simpler and exact at launch scale.
 */
export async function runValuePass(client: PublicClient, store: Store, cfg: OpsConfig): Promise<ValueResult> {
  const accounts = await store.listAccounts();
  if (accounts.length === 0) return { accounts: 0, block: 0 };

  const blk = await client.getBlock();
  const block = Number(blk.number);
  const ts = Number(blk.timestamp);

  const base = await readBaseAsset(client, cfg.registry);
  const positions = await enumeratePositions(client, cfg.registry);
  const decCache = new Map<string, number>();

  for (const a of accounts) {
    const value = await accountValueUsd6(client, a.account as Address, cfg, positions, base, decCache);
    await store.upsertValue(a.account, value.toString(), block, ts);
  }
  return { accounts: accounts.length, block };
}
