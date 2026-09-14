-- Traffic, subscriptions, the audit log and what each server reports.

-- The node as a sing-box client outbound (for the sing-box subscription), and
-- its traffic this month as its server counts it.
ALTER TABLE nodes ADD COLUMN outbound_enc TEXT;
ALTER TABLE nodes ADD COLUMN traffic_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN traffic_paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN traffic_at TEXT;
ALTER TABLE nodes ADD COLUMN reset_day INTEGER NOT NULL DEFAULT 1;

-- PSM's version on the server and its last status report (psm doctor, cores,
-- nodes, traffic; encrypted: it can hold node secrets).
ALTER TABLE servers ADD COLUMN psm_version TEXT;
ALTER TABLE servers ADD COLUMN status_enc TEXT;
ALTER TABLE servers ADD COLUMN status_at TEXT;

-- Bytes counted per node and day (UTC).
CREATE TABLE traffic_daily (
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    bytes   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (node_id, day)
);

-- Subscriptions: one URL over every running node, or those with given labels.
-- The token is kept encrypted (the panel shows the URL again) and as a hash
-- (to look it up).
CREATE TABLE subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    labels     TEXT NOT NULL DEFAULT '[]',
    token_hash TEXT NOT NULL UNIQUE,
    token_enc  TEXT NOT NULL,
    last_used  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What was done in the panel.
CREATE TABLE audit (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL DEFAULT (datetime('now')),
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_by_time ON audit (at);
