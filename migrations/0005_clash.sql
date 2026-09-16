-- A node as a ready mihomo proxy (psm node export --format clash), for the
-- Clash subscription: the TLS protocols, whose self-signed certificates
-- mihomo's share-link import cannot be told to accept.
ALTER TABLE nodes ADD COLUMN clash_enc TEXT;
