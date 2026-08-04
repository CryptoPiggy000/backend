// Sponsorship guards: we pay the gas, so a userOp only gets sponsored when (a) its calldata targets OUR
// contracts and (b) the sender is inside its daily quota. Together these stop both unrelated abuse (a
// stranger having us pay for arbitrary transactions) and adversarial users (opening an account, then
// looping to burn the budget). Neither limits what a legitimate user can DO with their own money.
// Run: `npm run test:gasless-guard`.
import { encodeFunctionData, type Address, type Hex } from "viem";
import { consumeQuota, extractTargets, predictAccount, validateSponsorship, type SponsorConfig } from "../src/gasless";

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) failures++;
};
const eqi = (a: unknown, b: unknown, msg: string) =>
  ok(String(a).toLowerCase() === String(b).toLowerCase(), `${msg}${String(a).toLowerCase() === String(b).toLowerCase() ? "" : ` (got ${a}, want ${b})`}`);

// LIVE Base mainnet values — the factory/impl we deployed, and a real (owner → account) pair pulled from
// the ops indexer. If the derivation below reproduces the real account, the maths matches the chain.
const FACTORY = "0x81af551F6346AE358966f3BF64d16d6105Ea1e8A" as Address;
const IMPL = "0x866fd7a8ea0d4d4fd0fabc42312074153c44d119" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const REAL_OWNER = "0x2a7a2995206c1e6fb264af2ccf8a45fbe1ddb916" as Address;
const REAL_ACCOUNT = "0x84f0f3bc3B504402C2536d7A27D80F76Aa909527" as Address;
const ZERO_SALT = `0x${"0".repeat(64)}` as Hex;
const CFG: SponsorConfig = { factory: FACTORY, implementation: IMPL, usdc: USDC, salt: ZERO_SALT };

const EXECUTE = [
  { name: "execute", type: "function", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] },
] as const;
const BATCH_07 = [
  { name: "executeBatch", type: "function", inputs: [{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes[]" }] },
] as const;
const BATCH_08 = [
  {
    name: "executeBatch",
    type: "function",
    inputs: [
      {
        type: "tuple[]",
        components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }],
      },
    ],
  },
] as const;

async function main() {
  console.log("predictAccount — against a REAL on-chain pair");
  eqi(
    predictAccount(CFG, REAL_OWNER),
    REAL_ACCOUNT,
    "derives the live account address from its owner (CREATE2 + EIP-1167, no RPC)",
  );
  ok(
    predictAccount(CFG, "0x000000000000000000000000000000000000dEaD" as Address).toLowerCase() !==
      REAL_ACCOUNT.toLowerCase(),
    "a different owner derives a different account",
  );

  console.log("extractTargets — all three calldata shapes");
  {
    const d = encodeFunctionData({ abi: EXECUTE, functionName: "execute", args: [USDC, 0n, "0x"] });
    eqi(extractTargets(d)?.[0], USDC, "decodes execute()");
  }
  {
    const d = encodeFunctionData({ abi: BATCH_07, functionName: "executeBatch", args: [[USDC, FACTORY], [0n, 0n], ["0x", "0x"]] });
    ok(extractTargets(d)?.length === 2, "decodes v0.7 executeBatch(address[],uint256[],bytes[])");
  }
  {
    const d = encodeFunctionData({
      abi: BATCH_08,
      functionName: "executeBatch",
      args: [[{ target: USDC, value: 0n, data: "0x" as Hex }]],
    });
    eqi(extractTargets(d)?.[0], USDC, "decodes v0.8 executeBatch(Call[])");
  }
  ok(extractTargets("0xdeadbeef") === null, "unknown selector → null (refuse, don't guess)");

  console.log("validateSponsorship — ours only");
  const piggy = predictAccount(CFG, REAL_OWNER);
  const callTo = (t: Address) => encodeFunctionData({ abi: EXECUTE, functionName: "execute", args: [t, 0n, "0x"] });

  ok(validateSponsorship({ sender: REAL_OWNER, callData: callTo(piggy) }, CFG).ok, "allows the sender's OWN piggy");
  ok(validateSponsorship({ sender: REAL_OWNER, callData: callTo(FACTORY) }, CFG).ok, "allows the factory (createAccount)");
  ok(validateSponsorship({ sender: REAL_OWNER, callData: callTo(USDC) }, CFG).ok, "allows USDC (withdraw transfer)");
  ok(
    !validateSponsorship({ sender: REAL_OWNER, callData: callTo("0x1111111111111111111111111111111111111111" as Address) }, CFG).ok,
    "REFUSES an unrelated contract — the drain vector",
  );
  ok(
    !validateSponsorship(
      { sender: "0x000000000000000000000000000000000000dEaD" as Address, callData: callTo(piggy) },
      CFG,
    ).ok,
    "REFUSES another user's piggy (would revert on-chain, and we'd still pay)",
  );
  {
    // one bad target in a batch poisons the whole op
    const d = encodeFunctionData({
      abi: BATCH_07,
      functionName: "executeBatch",
      args: [[piggy, "0x1111111111111111111111111111111111111111" as Address], [0n, 0n], ["0x", "0x"]],
    });
    ok(!validateSponsorship({ sender: REAL_OWNER, callData: d }, CFG).ok, "REFUSES a batch mixing ours with a stranger");
  }
  ok(!validateSponsorship({ sender: REAL_OWNER, callData: "0xdeadbeef" }, CFG).ok, "refuses undecodable calldata");
  ok(!validateSponsorship({ sender: undefined, callData: callTo(piggy) }, CFG).ok, "refuses a userOp with no sender");

  console.log("consumeQuota — per-sender daily cap");
  {
    // minimal in-memory stand-in for the D1 surface consumeQuota uses
    const rows = new Map<string, number>();
    const db = {
      prepare(sql: string) {
        return {
          bind(sender: string, day: string) {
            return {
              async first<T>() {
                const k = `${sender}|${day}`;
                const n = (rows.get(k) ?? 0) + 1;
                rows.set(k, n);
                return { count: n } as T;
              },
            };
          },
          async run() {
            void sql;
          },
        };
      },
    } as unknown as D1Database;

    const T0 = Date.parse("2026-08-04T10:00:00Z");
    const A = "0xAAAA000000000000000000000000000000000001";
    let last = await consumeQuota(db, A, 3, T0);
    ok(last.ok && last.used === 1, "1st call allowed");
    last = await consumeQuota(db, A, 3, T0);
    last = await consumeQuota(db, A, 3, T0);
    ok(last.ok && last.used === 3, "3rd call still allowed (at the limit)");
    last = await consumeQuota(db, A, 3, T0);
    ok(!last.ok && last.used === 4, "4th call REFUSED — over the daily cap");

    // a different sender has its own budget
    const B = "0xBBBB000000000000000000000000000000000002";
    ok((await consumeQuota(db, B, 3, T0)).ok, "another sender is unaffected");
    // and the window rolls at UTC midnight
    ok((await consumeQuota(db, A, 3, Date.parse("2026-08-05T00:01:00Z"))).ok, "quota resets the next UTC day");
    // case-insensitive: mixed-case addresses must not mint a fresh budget
    ok(!(await consumeQuota(db, A.toLowerCase(), 3, T0)).ok, "lowercased sender shares the same counter");
    // storage failure must not break gasless for real users
    const broken = { prepare() { throw new Error("d1 down"); } } as unknown as D1Database;
    ok((await consumeQuota(broken, A, 3, T0)).ok, "fails OPEN when the store errors");
    ok((await consumeQuota(undefined, A, 3, T0)).ok, "no DB bound → no quota (dev)");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
