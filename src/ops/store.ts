// The persistence seam. `Store` is the small set of queries the passes + API need; `D1Store` backs it
// with the shared cryptopiggy_market D1 in the worker, and a sqlite-backed impl backs it in the anvil
// integration test — so the index/value/api logic is exercised without a live Cloudflare runtime.

export interface AccountRow {
  account: string;
  owner: string;
  salt?: string | null;
  created_block?: number | null;
  created_ts?: number | null;
}

export interface FlowRow {
  tx_hash: string;
  log_index: number;
  account: string;
  kind: string; // 'deposit' | 'withdraw'
  amount: string; // µUSD
  net_after?: string | null;
  block: number;
  ts?: number | null;
}

export interface ValueRow {
  value_usd: string;
  block: number;
  ts: number | null;
}

export interface Store {
  init(schema: string): Promise<void>;
  upsertAccount(a: AccountRow): Promise<void>;
  insertFlow(f: FlowRow): Promise<void>;
  getCursor(deployBlock: bigint): Promise<bigint>;
  setCursor(block: bigint): Promise<void>;
  listAccounts(): Promise<AccountRow[]>;
  upsertValue(account: string, valueUsd: string, block: number, ts: number): Promise<void>;
  latestValues(): Promise<Map<string, string>>; // account → value_usd
  aggregate(): Promise<{ users: number; totalDeposited: string; totalWithdrawn: string }>;
  accountPrincipals(): Promise<Map<string, string>>; // account → net principal (µUSD, deposits − withdraws)
  accountFlows(account: string): Promise<FlowRow[]>;
  accountValues(account: string): Promise<ValueRow[]>;
  recentFlows(limit: number): Promise<(FlowRow & { owner?: string | null })[]>;
}

/** Split a .sql file into runnable statements (strip `--` comments; D1 can't exec multi-line scripts). */
export function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

const CURSOR = "cursor_block";

export class D1Store implements Store {
  constructor(private db: D1Database) {}

  async init(schema: string): Promise<void> {
    for (const stmt of splitSql(schema)) await this.db.prepare(stmt).run();
  }

  async upsertAccount(a: AccountRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ops_accounts (account, owner, salt, created_block, created_ts)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(account) DO NOTHING`,
      )
      .bind(a.account, a.owner, a.salt ?? null, a.created_block ?? null, a.created_ts ?? null)
      .run();
  }

  async insertFlow(f: FlowRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ops_flows (tx_hash, log_index, account, kind, amount, net_after, block, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tx_hash, log_index) DO NOTHING`,
      )
      .bind(f.tx_hash, f.log_index, f.account, f.kind, f.amount, f.net_after ?? null, f.block, f.ts ?? null)
      .run();
  }

  async getCursor(deployBlock: bigint): Promise<bigint> {
    const row = await this.db.prepare(`SELECT value FROM ops_meta WHERE key = ?`).bind(CURSOR).first<{ value: string }>();
    return row ? BigInt(row.value) : deployBlock;
  }

  async setCursor(block: bigint): Promise<void> {
    await this.db
      .prepare(`INSERT INTO ops_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(CURSOR, block.toString())
      .run();
  }

  async listAccounts(): Promise<AccountRow[]> {
    const r = await this.db.prepare(`SELECT account, owner, salt, created_block, created_ts FROM ops_accounts`).all<AccountRow>();
    return r.results ?? [];
  }

  async upsertValue(account: string, valueUsd: string, block: number, ts: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ops_account_value (account, value_usd, block, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(account, block) DO UPDATE SET value_usd = excluded.value_usd, ts = excluded.ts`,
      )
      .bind(account, valueUsd, block, ts)
      .run();
  }

  async latestValues(): Promise<Map<string, string>> {
    const r = await this.db
      .prepare(
        `SELECT av.account AS account, av.value_usd AS value_usd FROM ops_account_value av
         JOIN (SELECT account, MAX(block) AS mb FROM ops_account_value GROUP BY account) m
         ON av.account = m.account AND av.block = m.mb`,
      )
      .all<{ account: string; value_usd: string }>();
    return new Map((r.results ?? []).map((x) => [x.account, x.value_usd]));
  }

  async aggregate(): Promise<{ users: number; totalDeposited: string; totalWithdrawn: string }> {
    const users = await this.db.prepare(`SELECT COUNT(*) AS n FROM ops_accounts`).first<{ n: number }>();
    const dep = await this.db
      .prepare(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS s FROM ops_flows WHERE kind = 'deposit'`)
      .first<{ s: number }>();
    const wd = await this.db
      .prepare(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS s FROM ops_flows WHERE kind = 'withdraw'`)
      .first<{ s: number }>();
    return { users: users?.n ?? 0, totalDeposited: String(dep?.s ?? 0), totalWithdrawn: String(wd?.s ?? 0) };
  }

  async accountPrincipals(): Promise<Map<string, string>> {
    const r = await this.db
      .prepare(
        `SELECT account, SUM(CASE kind WHEN 'deposit' THEN CAST(amount AS INTEGER) ELSE -CAST(amount AS INTEGER) END) AS p
         FROM ops_flows GROUP BY account`,
      )
      .all<{ account: string; p: number }>();
    return new Map((r.results ?? []).map((x) => [x.account, String(x.p)]));
  }

  async accountFlows(account: string): Promise<FlowRow[]> {
    const r = await this.db
      .prepare(`SELECT * FROM ops_flows WHERE account = ? ORDER BY block ASC, log_index ASC`)
      .bind(account)
      .all<FlowRow>();
    return r.results ?? [];
  }

  async accountValues(account: string): Promise<ValueRow[]> {
    const r = await this.db
      .prepare(`SELECT value_usd, block, ts FROM ops_account_value WHERE account = ? ORDER BY block ASC`)
      .bind(account)
      .all<ValueRow>();
    return r.results ?? [];
  }

  async recentFlows(limit: number): Promise<(FlowRow & { owner?: string | null })[]> {
    const r = await this.db
      .prepare(
        `SELECT f.*, a.owner AS owner FROM ops_flows f LEFT JOIN ops_accounts a ON a.account = f.account
         ORDER BY f.block DESC, f.log_index DESC LIMIT ?`,
      )
      .bind(limit)
      .all<FlowRow & { owner?: string | null }>();
    return r.results ?? [];
  }
}
