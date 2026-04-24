-- User suspension: allows admins to freeze an account from earning new CPE
-- without deleting it. Suspended users keep state='active' but are excluded
-- from the poller's attendance credit and the cert generation queries.
ALTER TABLE users ADD COLUMN suspended_at TEXT;
