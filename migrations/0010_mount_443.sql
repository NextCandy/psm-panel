-- Sharing the public 443 port: the node listens on 127.0.0.1 and Nginx routes
-- the connection to it by the name in the TLS handshake (SNI), so several
-- nodes and a camouflage site can live on one port.
--
-- This is not a node setting PSM stores; it is how the node was created
-- (`psm node add … --mount-443`), and PSM refuses to move a node between
-- direct listening and the shared 443 as an update — that is a delete and an
-- add. The panel records it here so it can show it, send it with the node, and
-- keep it fixed afterwards.
ALTER TABLE nodes ADD COLUMN mount_443 INTEGER NOT NULL DEFAULT 0;
