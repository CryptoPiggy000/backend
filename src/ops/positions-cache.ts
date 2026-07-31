// Per-account cache for the live /account positions read.
//
// The reads run live against the RPC. Reading on EVERY request meant concurrent /account hits each fired
// their own outbound RPC burst; under load the worker exceeded a Cloudflare runtime limit mid-fetch and
// 500'd (the reads themselves are guarded, but a runtime-killed request can't be caught in JS). This cache
// removes that by making concurrency cheap:
//   - within `ttlMs` of the last success, serve the cached breakdown with NO network,
//   - on a miss, coalesce all concurrent callers for that account onto ONE in-flight read (single-flight),
//   - if a read fails, serve the last successful value so a transient error never blanks a portfolio
//     (a real close-out reads successfully as [] and correctly overwrites the cache).
//
// State lives for the worker isolate's lifetime; no eviction is needed at launch scale. `now` is passed in
// (not read from Date.now here) so the TTL logic is deterministic under test.
export interface CachedPositions<T> {
  value: T[];
  at: number; // `now` at which `value` was fetched
}

export class PositionsCache<T> {
  private fresh = new Map<string, CachedPositions<T>>();
  private inflight = new Map<string, Promise<T[]>>();

  constructor(private readonly ttlMs: number) {}

  async get(key: string, now: number, fetchFresh: () => Promise<T[]>): Promise<T[]> {
    const hit = this.fresh.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value; // fresh → no network

    const existing = this.inflight.get(key);
    if (existing) return existing; // a read is already running for this account → join it

    const p = (async () => {
      try {
        const value = await fetchFresh();
        this.fresh.set(key, { value, at: now });
        return value;
      } catch {
        return this.fresh.get(key)?.value ?? [];
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
