import { type PublicClient, zeroAddress } from "viem";
import { AccountCreated, DepositFeePaid, Deployed, Returned } from "./abi";
import { blockTimestamps, getEventLogs, type OpsConfig, readBaseAsset, readDecimals, usd6 } from "./chain";
import type { Store } from "./store";

export interface IndexResult {
  from: bigint;
  to: bigint;
  accounts: number;
  flows: number;
  fees: number;
}

/**
 * The fast pass: pull AccountCreated (factory) + Deployed/Returned (registry) from the block cursor up
 * to `latest − confirmations`, chunked by RANGE, and upsert accounts + flows. Idempotent — every write is
 * INSERT ... DO NOTHING keyed by (tx_hash, log_index) / account, so a re-run over the same range is a
 * no-op and the cursor only advances past a fully-processed range.
 */
export async function runIndexPass(client: PublicClient, store: Store, cfg: OpsConfig): Promise<IndexResult> {
  const latest = await client.getBlockNumber();
  const safeHead = latest > cfg.confirmations ? latest - cfg.confirmations : 0n;
  const from = await store.getCursor(cfg.deployBlock);
  if (safeHead < from) return { from, to: from, accounts: 0, flows: 0, fees: 0 };
  const to = safeHead;

  const created = await getEventLogs(client, cfg.factory, AccountCreated, from, to, cfg.range);
  const deployed = await getEventLogs(client, cfg.registry, Deployed, from, to, cfg.range);
  const returned = await getEventLogs(client, cfg.registry, Returned, from, to, cfg.range);
  // Fee events are emitted by the per-user account clones, not a fixed address → topic-only across all
  // addresses. (At larger scale, constrain to the known account set to avoid a wide topic scan.)
  const fees = await getEventLogs(client, undefined, DepositFeePaid, from, to, cfg.range);

  const ts = await blockTimestamps(
    client,
    [...created, ...deployed, ...returned, ...fees]
      .map((l) => l.blockNumber!)
      .filter((b): b is bigint => b != null),
  );

  // base-asset decimals → normalize flow amounts (raw USDC units) to canonical µUSD
  const base = await readBaseAsset(client, cfg.registry);
  const decCache = new Map<string, number>();
  const baseDec = base && base !== zeroAddress ? await readDecimals(client, base, decCache) : 6;

  for (const log of created) {
    const a = log.args as { owner: string; account: string; salt: string };
    await store.upsertAccount({
      account: a.account.toLowerCase(),
      owner: a.owner.toLowerCase(),
      salt: a.salt,
      created_block: Number(log.blockNumber),
      created_ts: ts.get(String(log.blockNumber)) ?? null,
    });
  }

  const writeFlows = async (logs: typeof deployed, kind: "deposit" | "withdraw") => {
    for (const log of logs) {
      const a = log.args as { account: string; amount: bigint; netDeployed: bigint };
      await store.insertFlow({
        tx_hash: log.transactionHash!,
        log_index: log.logIndex!,
        account: a.account.toLowerCase(),
        kind,
        amount: usd6(a.amount, baseDec).toString(),
        net_after: usd6(a.netDeployed, baseDec).toString(),
        block: Number(log.blockNumber),
        ts: ts.get(String(log.blockNumber)) ?? null,
      });
    }
  };
  await writeFlows(deployed, "deposit");
  await writeFlows(returned, "withdraw");

  // Revenue: each DepositFeePaid is stored as a 'fee' flow keyed to the emitting account (log.address).
  for (const log of fees) {
    const a = log.args as { fee: bigint };
    await store.insertFlow({
      tx_hash: log.transactionHash!,
      log_index: log.logIndex!,
      account: log.address.toLowerCase(),
      kind: "fee",
      amount: usd6(a.fee, baseDec).toString(),
      net_after: null,
      block: Number(log.blockNumber),
      ts: ts.get(String(log.blockNumber)) ?? null,
    });
  }

  await store.setCursor(to + 1n); // next unprocessed block
  return { from, to, accounts: created.length, flows: deployed.length + returned.length, fees: fees.length };
}
