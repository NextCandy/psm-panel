-- Admin sign-in and the panel's own settings.

-- Failed admin sign-ins, for the limit per address (10 in 15 minutes).
CREATE TABLE login_failures (
    ip TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX login_failures_by_ip ON login_failures (ip, at);

-- Settings the panel makes for itself, such as the key that encrypts node
-- settings in D1 when no TOKEN_KEY secret is set.
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
