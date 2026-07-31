// /account must stay up even if the live positions read fails. value/principal/accrued/activity all come
// from D1 (already indexed) — a transient RPC failure in the per-venue breakdown must NOT take the whole
// response down with a 500. It should degrade to positions:[] and still serve the D1 numbers. Standalone
// (no anvil): run with `npm run test:unit-api`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createApi } from "../src/ops/api";
import { SqliteStore } from "./sqlite-store";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) failures++;
};

async function main() {
  console.log("/account resilience when positionsFor fails");
  const schema = readFileSync(resolve(__dirname, "../src/ops/schema.sql"), "utf8");
  const store = new SqliteStore(":memory:");
  await store.init(schema);

  // positionsFor blows up like a rate-limited / down RPC would.
  const app = createApi(store, {
    positionsFor: async () => {
      throw new Error("rpc down");
    },
  });

  const res = await app.request("/account/0x1111111111111111111111111111111111111111");
  ok(res.status === 200, "returns 200 (not 500) when the positions read throws");
  const body = (await res.json()) as { positions: unknown[]; account: string; activity: unknown[] };
  ok(Array.isArray(body.positions) && body.positions.length === 0, "degrades to empty positions");
  ok(Array.isArray(body.activity), "still returns the activity array from D1");
  ok(typeof body.account === "string", "still returns the account envelope");

  // Gate the live (paid) positions read to addresses we actually index. /account is public + unauth, and
  // the venue tokens (WETH / aToken / Morpho vault) are SHARED, so an arbitrary address would otherwise
  // (a) trigger ~10 paid RPC reads on demand — a cost-abuse vector — and (b) report that address's
  // holdings as "positions" while value/principal read 0 from D1 (the 0xdead $7,560 inconsistency).
  console.log("gate live read to known accounts");
  const known = "0x84f0f3bc3b504402c2536d7a27d80f76aa909527";
  const unknown = "0x000000000000000000000000000000000000dead";
  const store2 = new SqliteStore(":memory:");
  await store2.init(schema);
  await store2.upsertValue(known, "5000000", 1, 1); // makes `known` a real indexed account ($5 valued)
  const called: string[] = [];
  const app2 = createApi(store2, {
    positionsFor: async (a) => {
      called.push(a);
      return [{ key: "0xk", name: "Aave", class: "savings", valueUsd: 5 }];
    },
  });
  const kr = (await (await app2.request(`/account/${known}`)).json()) as { positions: unknown[] };
  ok(kr.positions.length === 1, "known account: live positions read runs");
  ok(called.includes(known), "known account: positionsFor was called");
  const ur = (await (await app2.request(`/account/${unknown}`)).json()) as { positions: unknown[] };
  ok(ur.positions.length === 0, "unknown account: positions empty");
  ok(!called.includes(unknown), "unknown account: positionsFor NOT called (no paid RPC on arbitrary input)");

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
