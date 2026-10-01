-- A relay may land on a node of the panel (its parent, as other panels call
-- it): the relay then forwards to that node's address and port, follows them
-- when the node is edited, and the node is published a second time through
-- the relay — the same settings, the relay's entry address and port — in
-- every subscription that has the node.
--
-- entry_host: the address clients reach the entry server at ('' = the one its
-- psm-agent last synced from); in_sub: whether the relayed node is published.
ALTER TABLE relays ADD COLUMN node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE relays ADD COLUMN entry_host TEXT NOT NULL DEFAULT '';
ALTER TABLE relays ADD COLUMN in_sub INTEGER NOT NULL DEFAULT 1;
