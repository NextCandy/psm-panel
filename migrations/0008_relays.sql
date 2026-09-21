-- Relays (realm): a rule on the entry server that forwards one of its ports to
-- another host. Only the entry server runs a rule; the landing side keeps its
-- nodes as they are. The landing side may be another server in the panel
-- (remote_server_id, so the panel can pair the two and show the hop) or any
-- address at all, which is why remote_host is kept as text either way.
--
-- The hop can be wrapped in TLS. Nothing secret lives here: the certificate
-- and key stay on the server as paths, and the panel only records that TLS is
-- on, for which name, and whether a self-signed certificate is accepted.
CREATE TABLE relays (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id        INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    listen_port      INTEGER NOT NULL,
    remote_host      TEXT NOT NULL,
    remote_port      INTEGER NOT NULL,
    remote_server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
    udp              INTEGER NOT NULL DEFAULT 0,
    tls              INTEGER NOT NULL DEFAULT 0,
    tls_sni          TEXT NOT NULL DEFAULT '',
    tls_insecure     INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'waiting',   -- waiting | queued | applied | failed | deleting
    last_error       TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- one name per server, and one rule per listening port on that server
CREATE UNIQUE INDEX relays_name ON relays (server_id, name);
CREATE UNIQUE INDEX relays_port ON relays (server_id, listen_port);

-- A task belongs to a node or to a relay; node_id already exists.
ALTER TABLE tasks ADD COLUMN relay_id INTEGER REFERENCES relays(id) ON DELETE SET NULL;
