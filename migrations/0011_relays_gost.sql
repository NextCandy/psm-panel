-- Relays gain what gost brings (psm relay --engine gost): an engine, a mode
-- (a forward, or a tunnel from the entry server to an exit server that alone
-- forwards to the landing side), several landing targets shared by a strategy
-- with health checks, a rate limit, a monthly quota and an expiry, and a port
-- picked from the server's range when none is typed in.
--
-- A tunnel is one row and two rules, both named after the relay: the entry's
-- on server_id and the exit's on exit_server_id. The exit's rule goes first:
-- its certificate (public) comes back with the result, and the entry is sent
-- once it has it, to pin it. pending_entry is the entry task waiting for that.
ALTER TABLE relays ADD COLUMN engine TEXT NOT NULL DEFAULT 'realm';
ALTER TABLE relays ADD COLUMN mode TEXT NOT NULL DEFAULT 'forward';
ALTER TABLE relays ADD COLUMN targets TEXT NOT NULL DEFAULT '[]';
ALTER TABLE relays ADD COLUMN strategy TEXT NOT NULL DEFAULT '';
ALTER TABLE relays ADD COLUMN probe INTEGER NOT NULL DEFAULT 1;
ALTER TABLE relays ADD COLUMN auto_port INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relays ADD COLUMN exit_server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL;
ALTER TABLE relays ADD COLUMN exit_host TEXT NOT NULL DEFAULT '';
ALTER TABLE relays ADD COLUMN exit_port INTEGER;
ALTER TABLE relays ADD COLUMN exit_auto_port INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relays ADD COLUMN transport TEXT NOT NULL DEFAULT '';
ALTER TABLE relays ADD COLUMN ws_host TEXT NOT NULL DEFAULT '';
ALTER TABLE relays ADD COLUMN ws_path TEXT NOT NULL DEFAULT '';
ALTER TABLE relays ADD COLUMN secret_enc TEXT;
ALTER TABLE relays ADD COLUMN exit_cert TEXT;
ALTER TABLE relays ADD COLUMN exit_status TEXT NOT NULL DEFAULT '';
ALTER TABLE relays ADD COLUMN exit_error TEXT;
ALTER TABLE relays ADD COLUMN pending_entry TEXT NOT NULL DEFAULT '';
ALTER TABLE relays ADD COLUMN exit_rtt_ms REAL;
ALTER TABLE relays ADD COLUMN exit_loss_pct REAL;
ALTER TABLE relays ADD COLUMN speed_mbps REAL NOT NULL DEFAULT 0;
ALTER TABLE relays ADD COLUMN limit_gb REAL NOT NULL DEFAULT 0;
ALTER TABLE relays ADD COLUMN reset_day INTEGER NOT NULL DEFAULT 1;
ALTER TABLE relays ADD COLUMN expires_at TEXT;
ALTER TABLE relays ADD COLUMN quota_used INTEGER;
ALTER TABLE relays ADD COLUMN paused TEXT NOT NULL DEFAULT '';
ALTER TABLE relays ADD COLUMN target_health TEXT;

-- a relay's listening port picked on a server when none is typed in: from
-- this range (20000-60000 when not set)
ALTER TABLE servers ADD COLUMN relay_port_min INTEGER;
ALTER TABLE servers ADD COLUMN relay_port_max INTEGER;
-- where the server's agent reached the panel from, offered as a tunnel exit's address
ALTER TABLE servers ADD COLUMN last_ip TEXT;
