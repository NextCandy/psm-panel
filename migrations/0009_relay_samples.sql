-- How a relay's hop is doing, as its entry server measures it: psm-agent
-- probes the landing side every 60 seconds and ships the reading with its
-- sync, the way it already ships the traffic counters.
--
-- One row per reading. `bytes` is the traffic of that interval, not the
-- running total: the counter on the server only ever grows (and resets when
-- the rules are rebuilt), so the panel stores the difference and keeps the
-- last counter it saw on the relay itself.
CREATE TABLE relay_samples (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    relay_id  INTEGER NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
    at        TEXT NOT NULL DEFAULT (datetime('now')),
    rtt_ms    REAL,                        -- NULL: nothing in the burst connected
    jitter_ms REAL,
    loss_pct  REAL NOT NULL DEFAULT 0,
    bytes     INTEGER NOT NULL DEFAULT 0
);

-- the charts read one relay over a window, newest last
CREATE INDEX relay_samples_by_relay ON relay_samples (relay_id, at);

-- The last counter seen (to turn a growing total into an interval), and the
-- newest reading, so the list can show a relay's state without reading the
-- samples at all.
ALTER TABLE relays ADD COLUMN meter_bytes    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relays ADD COLUMN traffic_bytes  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relays ADD COLUMN last_rtt_ms    REAL;
ALTER TABLE relays ADD COLUMN last_jitter_ms REAL;
ALTER TABLE relays ADD COLUMN last_loss_pct  REAL;
ALTER TABLE relays ADD COLUMN last_sample_at TEXT;
