import { type PublicClient, zeroAddress } from "viem";
import { AccountCreated, ADMIN_EVENTS, DepositFeePaid, Deployed, Returned } from "./abi";
import {
  blockTimestamps,
  getEventLogs,
  getMultiEventLogs,
  type OpsConfig,
  readBaseAsset,
  readDecimals,
  readDepositFee,
  usd6,
} from "./chain";
import type { Store } from "./store";

export interface IndexResult {
  from: bigint;
  to: bigint;
  accounts: number;
  flows: number;
  fees: number;
  admin: number;
}

// Event args may contain bigints (cap, bps, adapterType…) → serialize them as strings for JSON storage.
const argsJson = (args: Record<string, unknown>): string =>
  JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

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
  if (safeHead < from) {
    await snapshotFee(client, store, cfg); // keep the current-fee meta fresh even with no new blocks
    return { from, to: from, accounts: 0, flows: 0, fees: 0, admin: 0 };
  }
  const to = safeHead;

  const created = await getEventLogs(client, cfg.factory, AccountCreated, from, to, cfg.range);
  const deployed = await getEventLogs(client, cfg.registry, Deployed, from, to, cfg.range);
  const returned = await getEventLogs(client, cfg.registry, Returned, from, to, cfg.range);
  // Fee events are emitted by the per-user account clones, not a fixed address → topic-only across all
  // addresses. (At larger scale, constrain to the known account set to avoid a wide topic scan.)
  const fees = await getEventLogs(client, undefined, DepositFeePaid, from, to, cfg.range);
  // Governance/admin audit trail — all registry config events in one call.
  const admin = await getMultiEventLogs(client, cfg.registry, ADMIN_EVENTS, from, to, cfg.range);

  const ts = await blockTimestamps(
    client,
    [...created, ...deployed, ...returned, ...fees, ...admin]
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

  // Admin/governance audit rows (event name + JSON args).
  for (const log of admin) {
    await store.insertAdminEvent({
      tx_hash: log.transactionHash!,
      log_index: log.logIndex!,
      event: log.eventName,
      args: argsJson(log.args),
      block: Number(log.blockNumber),
      ts: ts.get(String(log.blockNumber)) ?? null,
    });
  }

  await snapshotFee(client, store, cfg); // current fee for /stats
  await store.setCursor(to + 1n); // next unprocessed block
  return {
    from,
    to,
    accounts: created.length,
    flows: deployed.length + returned.length,
    fees: fees.length,
    admin: admin.length,
  };
}

/** Read the live deposit fee and cache it in meta, so /stats can show the current rate without a chain read. */
async function snapshotFee(client: PublicClient, store: Store, cfg: OpsConfig): Promise<void> {
  try {
    const { bps, collector } = await readDepositFee(client, cfg.registry);
    await store.setMeta("fee_bps", String(bps));
    await store.setMeta("fee_collector", collector);
  } catch {
    // registry may predate depositFee() (or be unset) → leave meta as-is
  }
}
