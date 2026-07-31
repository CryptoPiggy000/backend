// Unit test for PositionsCache — the per-account cache behind the live /account positions read. It exists
// so concurrent /account hits don't each fire an outbound RPC read (that storm was 500-ing the worker):
//   - serves a cached value while it's younger than ttlMs (no network),
//   - coalesces concurrent misses for one account into a SINGLE in-flight read (single-flight),
//   - returns the last successful value if a read fails (never blanks a portfolio on a transient error).
// Standalone (no anvil/RPC): run with `npm run test:unit`.
import { PositionsCache } from "../src/ops/positions-cache";

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) failures++;
};
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), msg);

async function main() {
  console.log("PositionsCache");

  // 1) fresh hit within TTL → no refetch
  {
    const c = new PositionsCache<string>(1000);
    let calls = 0;
    const f = async () => {
      calls++;
      return ["A"];
    };
    eq(await c.get("a", 0, f), ["A"], "miss returns the fetched value");
    eq(await c.get("a", 500, f), ["A"], "within TTL returns the cached value");
    eq(calls, 1, "within TTL: served from cache, no refetch");
  }

  // 2) expired entry → refetch
  {
    const c = new PositionsCache<string>(1000);
    let calls = 0;
    const f = async () => {
      calls++;
      return [`v${calls}`];
    };
    await c.get("a", 0, f);
    await c.get("a", 1500, f);
    eq(calls, 2, "past TTL: refetch");
  }

  // 3) single-flight: concurrent misses for one account → ONE fetch (the fix for the RPC storm)
  {
    const c = new PositionsCache<string>(1000);
    let calls = 0;
    let resolve!: (v: string[]) => void;
    const f = () => {
      calls++;
      return new Promise<string[]>((r) => {
        resolve = r;
      });
    };
    const p1 = c.get("a", 0, f);
    const p2 = c.get("a", 0, f);
    const p3 = c.get("a", 0, f);
    resolve(["X"]);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    eq(calls, 1, "single-flight: one fetch for 3 concurrent callers");
    ok(JSON.stringify([r1, r2, r3]) === JSON.stringify([["X"], ["X"], ["X"]]), "all concurrent callers get the value");
  }

  // 4) failed read → last-good
  {
    const c = new PositionsCache<string>(0); // ttl 0 → every call is a miss
    await c.get("a", 0, async () => ["A"]);
    const r = await c.get("a", 1, async () => {
      throw new Error("rpc down");
    });
    eq(r, ["A"], "failed read returns the last-good value");
  }

  // 5) no prior + error → []
  {
    const c = new PositionsCache<string>(0);
    eq(
      await c.get("new", 0, async () => {
        throw new Error("x");
      }),
      [],
      "failure with no prior returns empty",
    );
  }

  // 6) a real empty read (withdrawal) is cached and served within TTL
  {
    const c = new PositionsCache<string>(1000);
    await c.get("a", 0, async () => ["A"]);
    eq(await c.get("a", 1500, async () => []), [], "a real empty read is returned");
    let calls = 0;
    eq(
      await c.get("a", 1600, async () => {
        calls++;
        return ["SHOULD-NOT-REFETCH"];
      }),
      [],
      "empty result is cached and served within TTL",
    );
    eq(calls, 0, "no refetch within TTL after an empty result");
  }

  // 7) per-account isolation
  {
    const c = new PositionsCache<string>(1000);
    await c.get("A", 0, async () => ["a-pos"]);
    await c.get("B", 0, async () => ["b-pos"]);
    eq(await c.get("A", 1, async () => ["ignored"]), ["a-pos"], "account A returns A's value, not B's");
  }

  // 8) in-flight is cleared after resolve → a later expired call refetches (not stuck)
  {
    const c = new PositionsCache<string>(100);
    let calls = 0;
    const f = async () => {
      calls++;
      return [`v${calls}`];
    };
    await c.get("a", 0, f);
    await c.get("a", 200, f);
    eq(calls, 2, "in-flight cleared: an expired call after it refetches");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
