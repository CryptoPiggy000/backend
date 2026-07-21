import Database from "better-sqlite3";
import type { AccountRow, AdminEventRow, FlowRow, Store, ValueRow } from "../src/ops/store";
import { splitSql } from "../src/ops/store";

// A synchronous better-sqlite3 impl of the same Store the worker backs with D1 — lets the integration
// test exercise the real index/value/api logic against anvil without a live Cloudflare runtime. The
// query SQL mirrors D1Store (D1 and SQLite share dialect + `?` placeholders).
export class SqliteStore implements Store {
  private db: Database.Database;
  constructor(path = ":memory:") {
    this.db = new Database(path);
  }

  async init(schema: string): Promise<void> {
    for (const stmt of splitSql(schema)) this.db.prepare(stmt).run();
  }

  async upsertAccount(a: AccountRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO ops_accounts (account, owner, salt, created_block, created_ts)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(account) DO NOTHING`,
      )
      .run(a.account, a.owner, a.salt ?? null, a.created_block ?? null, a.created_ts ?? null);
  }

  async insertFlow(f: FlowRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO ops_flows (tx_hash, log_index, account, kind, amount, net_after, block, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tx_hash, log_index) DO NOTHING`,
      )
      .run(f.tx_hash, f.log_index, f.account, f.kind, f.amount, f.net_after ?? null, f.block, f.ts ?? null);
  }

  async insertAdminEvent(e: AdminEventRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO ops_admin_events (tx_hash, log_index, event, args, block, ts)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tx_hash, log_index) DO NOTHING`,
      )
      .run(e.tx_hash, e.log_index, e.event, e.args, e.block, e.ts ?? null);
  }

  async adminEvents(limit: number): Promise<AdminEventRow[]> {
    return this.db
      .prepare(`SELECT * FROM ops_admin_events ORDER BY block DESC, log_index DESC LIMIT ?`)
      .all(limit) as AdminEventRow[];
  }

  async getMeta(key: string): Promise<string | null> {
    const row = this.db.prepare(`SELECT value FROM ops_meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db
      .prepare(`INSERT INTO ops_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  async getCursor(deployBlock: bigint): Promise<bigint> {
    const v = await this.getMeta("cursor_block");
    return v !== null ? BigInt(v) : deployBlock;
  }

  async setCursor(block: bigint): Promise<void> {
    await this.setMeta("cursor_block", block.toString());
  }

  async listAccounts(): Promise<AccountRow[]> {
    return this.db.prepare(`SELECT account, owner, salt, created_block, created_ts FROM ops_accounts`).all() as AccountRow[];
  }

  async upsertValue(account: string, valueUsd: string, block: number, ts: number): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO ops_account_value (account, value_usd, block, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(account, block) DO UPDATE SET value_usd = excluded.value_usd, ts = excluded.ts`,
      )
      .run(account, valueUsd, block, ts);
  }

  async latestValues(): Promise<Map<string, string>> {
    const rows = this.db
      .prepare(
        `SELECT av.account AS account, av.value_usd AS value_usd FROM ops_account_value av
         JOIN (SELECT account, MAX(block) AS mb FROM ops_account_value GROUP BY account) m
         ON av.account = m.account AND av.block = m.mb`,
      )
      .all() as { account: string; value_usd: string }[];
    return new Map(rows.map((x) => [x.account, x.value_usd]));
  }

  async aggregate(): Promise<{ users: number; totalDeposited: string; totalWithdrawn: string; totalFees: string }> {
    const users = (this.db.prepare(`SELECT COUNT(*) AS n FROM ops_accounts`).get() as { n: number }).n;
    const sum = (kind: string) =>
      String(
        (this.db.prepare(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS s FROM ops_flows WHERE kind = ?`).get(kind) as { s: number }).s,
      );
    return { users, totalDeposited: sum("deposit"), totalWithdrawn: sum("withdraw"), totalFees: sum("fee") };
  }

  async accountPrincipals(): Promise<Map<string, string>> {
    const rows = this.db
      .prepare(
        `SELECT account, SUM(CASE kind WHEN 'deposit' THEN CAST(amount AS INTEGER) ELSE -CAST(amount AS INTEGER) END) AS p
         FROM ops_flows GROUP BY account`,
      )
      .all() as { account: string; p: number }[];
    return new Map(rows.map((x) => [x.account, String(x.p)]));
  }

  async accountFlows(account: string): Promise<FlowRow[]> {
    return this.db.prepare(`SELECT * FROM ops_flows WHERE account = ? ORDER BY block ASC, log_index ASC`).all(account) as FlowRow[];
  }

  async accountValues(account: string): Promise<ValueRow[]> {
    return this.db.prepare(`SELECT value_usd, block, ts FROM ops_account_value WHERE account = ? ORDER BY block ASC`).all(account) as ValueRow[];
  }

  async recentFlows(limit: number): Promise<(FlowRow & { owner?: string | null })[]> {
    return this.db
      .prepare(
        `SELECT f.*, a.owner AS owner FROM ops_flows f LEFT JOIN ops_accounts a ON a.account = f.account
         ORDER BY f.block DESC, f.log_index DESC LIMIT ?`,
      )
      .all(limit) as (FlowRow & { owner?: string | null })[];
  }
}
