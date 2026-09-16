-- What a task that answers a question brings back (sni.find: the camouflage
-- targets a server found), for the page that asked.
ALTER TABLE tasks ADD COLUMN result_enc TEXT;
