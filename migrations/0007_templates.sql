-- Subscription templates: the user's own (the built-in ones live in the
-- Worker's code), and which template each subscription uses per format.
CREATE TABLE templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    format     TEXT NOT NULL,              -- clash | stash | singbox | surge | quanx | loon
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
);
ALTER TABLE subscriptions ADD COLUMN templates TEXT NOT NULL DEFAULT '{}';   -- {"surge": 3, …}; absent = built-in
