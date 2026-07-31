// Per-account "last good" fallback for the live per-account read (`/account/:addr` positions).
//
// The reads run live against the RPC, so a transient failure (rate limit, timeout, a flaky node)
// used to collapse to `catch(() => [])` — indistinguishable from a genuinely empty portfolio, which
// made the client flip between the full breakdown and nothing. Here we keep the last successful
// breakdown per account and serve it when a fresh read throws, so a blip degrades to slightly-stale
// instead of blank. A real close-out reads successfully as `[]` and correctly overwrites the cache.
//
// The cache holds only already-public, per-account data and lives for the worker isolate's lifetime;
// there is no TTL because on failure "stale but real" always beats "blank".
export type PositionsCache<T> = Map<string, T[]>;

export async function withLastGood<T>(
  key: string,
  cache: PositionsCache<T>,
  fetchFresh: () => Promise<T[]>,
): Promise<T[]> {
  try {
    const value = await fetchFresh();
    cache.set(key, value);
    return value;
  } catch {
    return cache.get(key) ?? [];
  }
}
