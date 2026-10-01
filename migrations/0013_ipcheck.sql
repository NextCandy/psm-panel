-- Each server's last IP quality and unlock check (psm check, run by
-- psm-agent 0.12.0 and later when the 服务器 page asks): the report,
-- encrypted like the status report, when it came, and why it failed if it did.
ALTER TABLE servers ADD COLUMN check_enc TEXT;
ALTER TABLE servers ADD COLUMN check_at TEXT;
ALTER TABLE servers ADD COLUMN check_error TEXT;
