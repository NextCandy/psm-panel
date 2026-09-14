-- Servers the panel manages. The psm-api token is stored encrypted
-- (AES-GCM, key in the TOKEN_KEY Worker secret); it is never returned.
CREATE TABLE servers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    api_url       TEXT NOT NULL,
    api_token_enc TEXT NOT NULL,
    note          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
