-- cryptopiggy-ops tables. Idempotent DDL (NOT wrangler migrations) — applied at worker startup and via
-- `wrangler d1 execute --file`. All ops_-prefixed so they share cryptopiggy_market without ever touching
-- the engine's market tables. Monetary values are canonical µUSD (integer, 6dp) decimal strings.

CREATE TABLE IF NOT EXISTS ops_accounts (
  account       TEXT PRIMARY KEY,   -- the SmartInvestmentAccount clone address (lowercased)
  owner         TEXT NOT NULL,      -- the user's EOA
  salt          TEXT,
  created_block INTEGER,
  created_ts    INTEGER
);

CREATE TABLE IF NOT EXISTS ops_flows (
  tx_hash   TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  account   TEXT NOT NULL,
  kind      TEXT NOT NULL,          -- 'deposit' | 'withdraw'
  amount    TEXT NOT NULL,          -- µUSD (6dp) integer string
  net_after TEXT,                   -- netDeployed after this flow, µUSD (from the event)
  block     INTEGER NOT NULL,
  ts        INTEGER,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS ops_flows_account ON ops_flows(account);
CREATE INDEX IF NOT EXISTS ops_flows_block   ON ops_flows(block);

CREATE TABLE IF NOT EXISTS ops_account_value (
  account    TEXT NOT NULL,
  value_usd  TEXT NOT NULL,         -- µUSD (6dp) integer string
  block      INTEGER NOT NULL,
  ts         INTEGER,
  PRIMARY KEY (account, block)
);

CREATE TABLE IF NOT EXISTS ops_meta (key TEXT PRIMARY KEY, value TEXT);
