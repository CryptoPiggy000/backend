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

-- Governance audit trail: every ProtocolRegistry admin action (fee/cap/whitelist/protocol/asset/route/
-- factory/base-asset changes). A public on-chain record that admin powers stayed within bounds.
CREATE TABLE IF NOT EXISTS ops_admin_events (
  tx_hash   TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  event     TEXT NOT NULL,       -- e.g. 'DepositFeeBpsSet'
  args      TEXT NOT NULL,       -- JSON of the event args (bigints as strings)
  block     INTEGER NOT NULL,
  ts        INTEGER,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS ops_admin_events_event ON ops_admin_events(event);
CREATE INDEX IF NOT EXISTS ops_admin_events_block ON ops_admin_events(block);

CREATE TABLE IF NOT EXISTS ops_meta (key TEXT PRIMARY KEY, value TEXT);
