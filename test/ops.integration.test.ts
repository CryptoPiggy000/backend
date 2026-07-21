// Anvil integration test for the ops indexer. Driven by test/run-ops-it.sh, which starts anvil, runs the
// OpsScenario forge script, and passes the deployed addresses in via env. Here we point the real index +
// value passes and the JSON API at that chain and assert the numbers. Run: `npm run test:ops`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Address } from "viem";
import { makeClient, type OpsConfig } from "../src/ops/chain";
import { runIndexPass } from "../src/ops/indexer";
import { runValuePass } from "../src/ops/value";
import { createApi } from "../src/ops/api";
import { SqliteStore } from "./sqlite-store";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) failures++;
};
const eq = (a: unknown, b: unknown, msg: string) => ok(a === b, `${msg} (got ${a}, want ${b})`);

async function main() {
  const rpc = process.env.RPC ?? "http://127.0.0.1:8545";
  const schema = readFileSync(resolve(__dirname, "../src/ops/schema.sql"), "utf8");
  const wsteth = env("WSTETH").toLowerCase();

  const cfg: OpsConfig = {
    registry: env("REGISTRY") as Address,
    factory: env("FACTORY") as Address,
    deployBlock: 0n,
    confirmations: 0n, // anvil: index up to head
    range: 5000n,
    aTokens: {},
    chainlink: {},
    priceOverrides: { [wsteth]: 2500 }, // 1 wstETH = $2500 (matches the mock router rate)
    heldAssets: [wsteth as Address],
  };

  const store = new SqliteStore(":memory:");
  await store.init(schema);
  const client = makeClient(rpc);

  // Scenario runs a 1% entry fee, so deposits deploy NET (297/495) and each emits DepositFeePaid.
  const M = (usd: number) => String(BigInt(usd) * 10n ** 6n);
  console.log("index pass:");
  const r1 = await runIndexPass(client, store, cfg);
  eq(r1.accounts, 2, "AccountCreated indexed for both users");
  eq(r1.flows, 4, "flows indexed = 3 deposits + 1 withdraw");
  eq(r1.fees, 2, "DepositFeePaid indexed = 2 (one per savings deposit)");

  const accounts = await store.listAccounts();
  eq(accounts.length, 2, "two accounts stored");
  const owner1 = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  const owner2 = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
  ok(accounts.some((a) => a.owner === owner1), "user1 is an owner");
  ok(accounts.some((a) => a.owner === owner2), "user2 is an owner");

  console.log("aggregate:");
  const agg = await store.aggregate();
  eq(agg.users, 2, "user count");
  eq(agg.totalDeposited, M(992), "totalDeposited = $992 net (297 + 200 buy + 495)");
  eq(agg.totalWithdrawn, M(200), "totalWithdrawn = $200");
  eq(agg.totalFees, M(8), "totalFees = $8 revenue (1% of 300 + 1% of 500)");

  console.log("value pass:");
  await runValuePass(client, store, cfg);
  const values = await store.latestValues();
  const acct1 = env("ACCT1").toLowerCase();
  const acct2 = env("ACCT2").toLowerCase();
  eq(values.get(acct1), M(997), "acct1 value = $997 (idle 500 + aave 297 + wstETH 200)");
  eq(values.get(acct2), M(995), "acct2 value = $995 (idle 700 + aave 295)");

  console.log("JSON API:");
  const app = createApi(store, { adminKey: "test-key", corsOrigin: "*" });
  const stats = await (await app.request("/stats")).json();
  eq(stats.users, 2, "/stats users");
  eq(stats.netPrincipal, 792, "/stats netPrincipal = $792");
  eq(stats.aum, 1992, "/stats aum = $1992");
  eq(stats.revenue, 8, "/stats revenue = $8 (deposit fees)");

  const unauth = await app.request("/ops/accounts");
  eq(unauth.status, 401, "/ops/accounts without bearer → 401");
  const opsRes = await app.request("/ops/accounts", { headers: { Authorization: "Bearer test-key" } });
  const ops = await opsRes.json();
  eq(ops.accounts.length, 2, "/ops/accounts lists both");
  eq(
    ops.accounts.reduce((s: number, a: { value: number }) => s + a.value, 0),
    1992,
    "account values sum to $1992",
  );

  console.log("idempotency:");
  const r2 = await runIndexPass(client, store, cfg); // cursor is past head → no re-read
  const agg2 = await store.aggregate();
  eq(agg2.totalDeposited, agg.totalDeposited, "re-run does not double-count deposits");
  eq(agg2.totalWithdrawn, agg.totalWithdrawn, "re-run does not double-count withdrawals");
  void r2;

  console.log(failures === 0 ? "\nPASS — ops indexer integration green" : `\nFAIL — ${failures} assertion(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
