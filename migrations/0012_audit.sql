-- From the 2026-09-26 code audit.
--
-- Indexes for what the panel looks up by: the daily totals by day, a node's
-- or relay's tasks, finished tasks and old samples (the daily clean-up), a
-- server's join tokens.
CREATE INDEX IF NOT EXISTS traffic_daily_by_day ON traffic_daily (day);
CREATE INDEX IF NOT EXISTS tasks_by_node ON tasks (node_id, status);
CREATE INDEX IF NOT EXISTS tasks_by_relay ON tasks (relay_id, status);
CREATE INDEX IF NOT EXISTS tasks_by_finished ON tasks (finished_at);
CREATE INDEX IF NOT EXISTS relay_samples_by_at ON relay_samples (at);
CREATE INDEX IF NOT EXISTS join_tokens_by_server ON join_tokens (server_id);

-- The network a server's agent syncs from (Cloudflare tells the Worker): the
-- REALITY camouflage search asks the mapping engine for hosts there itself,
-- so the engine's key never leaves the panel.
ALTER TABLE servers ADD COLUMN asn INTEGER;
ALTER TABLE servers ADD COLUMN country TEXT;

-- A server's install command shown again rather than a new token minted for
-- every node added to it (kept encrypted, like a subscription's token).
ALTER TABLE join_tokens ADD COLUMN token_enc TEXT;

-- Syncs in the current minute, per server: an agent token that syncs far more
-- often than any psm-agent does is told to slow down.
ALTER TABLE servers ADD COLUMN sync_window TEXT;
ALTER TABLE servers ADD COLUMN sync_count INTEGER NOT NULL DEFAULT 0;
