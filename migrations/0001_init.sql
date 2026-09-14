-- PSM panel schema. Servers run psm-agent, which syncs with the panel; the
-- panel keeps the nodes as entered and a queue of tasks for each server.

CREATE TABLE servers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL UNIQUE,
    agent_token_hash TEXT UNIQUE,          -- SHA-256 of the agent token; NULL until the server joins
    hostname         TEXT,
    agent_version    TEXT,
    note             TEXT NOT NULL DEFAULT '',
    last_seen        TEXT,                 -- last sync
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time join tokens for the install command; only their SHA-256 is kept.
CREATE TABLE join_tokens (
    token_hash TEXT PRIMARY KEY,
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at    TEXT
);

-- Nodes as entered in the panel. params (passwords, keys) and the client link
-- are stored encrypted (AES-GCM, key in the TOKEN_KEY Worker secret).
CREATE TABLE nodes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id        INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    protocol         TEXT NOT NULL,
    variant          TEXT NOT NULL,
    engine           TEXT NOT NULL,                  -- xray | sing-box | mihomo | standalone
    psm_protocol     TEXT NOT NULL,
    name             TEXT NOT NULL,
    address          TEXT NOT NULL,
    port             INTEGER NOT NULL,
    public_port      INTEGER,
    traffic_limit_gb REAL NOT NULL DEFAULT 0,
    labels           TEXT NOT NULL DEFAULT '[]',
    params_enc       TEXT NOT NULL,
    link_enc         TEXT,
    status           TEXT NOT NULL DEFAULT 'waiting', -- waiting | queued | applied | failed | deleting
    last_error       TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (server_id, name)
);

-- Tasks for psm-agent. The payload carries node settings, so it is encrypted.
CREATE TABLE tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    node_id     INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    kind        TEXT NOT NULL,
    payload_enc TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued',       -- queued | running | done | failed
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    claimed_at  TEXT,
    finished_at TEXT
);
CREATE INDEX tasks_by_server ON tasks (server_id, status);
