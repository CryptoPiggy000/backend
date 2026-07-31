// Unit test for withLastGood — the per-account "last good" fallback that replaces the old
// `positionsFor(addr).catch(() => [])`. A transient RPC failure must NOT blank a portfolio that
// read fine a moment ago; it should return the last successful breakdown instead. Standalone
// (no anvil/forge): run with `npm run test:unit`.
import { withLastGood, type PositionsCache } from "../src/ops/positions-cache";

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) failures++;
};
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), msg);

async function main() {
  console.log("withLastGood");

  // 1) success returns fresh AND caches it
  {
    const cache: PositionsCache<string> = new Map();
    const out = await withLastGood("0xabc", cache, async () => ["Aave", "WETH"]);
    eq(out, ["Aave", "WETH"], "success returns fresh positions");
    eq(cache.get("0xabc"), ["Aave", "WETH"], "success stores positions as last-good");
  }

  // 2) failure AFTER a success returns the last good (not [])
  {
    const cache: PositionsCache<string> = new Map();
    await withLastGood("0xabc", cache, async () => ["Aave", "WETH"]);
    const out = await withLastGood("0xabc", cache, async () => {
      throw new Error("cu limit exceeded");
    });
    eq(out, ["Aave", "WETH"], "failure with prior good returns last-good, not empty");
  }

  // 3) failure with NO prior good returns [] (honest empty on first-ever load)
  {
    const cache: PositionsCache<string> = new Map();
    const out = await withLastGood("0xnew", cache, async () => {
      throw new Error("boom");
    });
    eq(out, [], "failure with no prior returns empty");
  }

  // 4) a genuinely-empty successful read overwrites a stale last-good (real close-out, not a blip)
  {
    const cache: PositionsCache<string> = new Map();
    await withLastGood("0xabc", cache, async () => ["Aave"]);
    const out = await withLastGood("0xabc", cache, async () => []);
    eq(out, [], "successful empty read overwrites last-good (a real withdrawal)");
    eq(cache.get("0xabc"), [], "cache reflects the real empty result");
  }

  // 5) per-account isolation — one account's failure doesn't leak another's data
  {
    const cache: PositionsCache<string> = new Map();
    await withLastGood("0xA", cache, async () => ["A-pos"]);
    await withLastGood("0xB", cache, async () => ["B-pos"]);
    const out = await withLastGood("0xA", cache, async () => {
      throw new Error("fail A");
    });
    eq(out, ["A-pos"], "account A falls back to A's last-good, not B's");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
