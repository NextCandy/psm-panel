-- Removing a server: its agent first deletes the panel's nodes and uninstalls
-- itself (the server shows as leaving until it reports).
ALTER TABLE servers ADD COLUMN leaving INTEGER NOT NULL DEFAULT 0;
ALTER TABLE servers ADD COLUMN leave_error TEXT;
