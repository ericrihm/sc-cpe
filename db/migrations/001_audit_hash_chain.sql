-- 001_audit_hash_chain.sql
-- Adds a hash chain to audit_log so that tampering with or deleting a row
-- invalidates every row that follows. Each new row's prev_hash is SHA-256 of
-- the prior row's canonical JSON array:
--   [id, actor_type, actor_id, action, entity_type, entity_id,
--    before_json, after_json, ip_hash, user_agent, ts, prev_hash]
-- serialised with no whitespace (JSON.stringify default / Python separators=(",",":")).
-- The first row in the chain (the "genesis" row) has prev_hash = NULL.
--
-- Concurrency model: writers do SELECT tip -> compute -> INSERT. The unique
-- index on prev_hash serialises writes at the DB layer: if two writers pick
-- the same tip, the second INSERT hits UNIQUE and the helper retries. Multiple
-- NULL prev_hash values are allowed by SQLite partial unique indexes, so
-- the genesis-row singleton invariant is enforced via COALESCE: every
-- genesis row indexes the literal string 'GENESIS', making at most one
-- allowed.
--
-- Apply to D1:
--   wrangler d1 execute sc-cpe --file=db/migrations/001_audit_hash_chain.sql --remote
--
-- Verify after: python scripts/verify_audit_chain.py

ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS audit_prev_hash_unique
    ON audit_log(prev_hash) WHERE prev_hash IS NOT NULL;

-- At most one genesis row ever. Partial unique indexes in SQLite treat
-- NULLs as distinct, so we index a literal 'GENESIS' key for the subset
-- of rows where prev_hash IS NULL. Uniqueness on that key caps to one.
CREATE UNIQUE INDEX IF NOT EXISTS audit_genesis_once
    ON audit_log(COALESCE(prev_hash, 'GENESIS')) WHERE prev_hash IS NULL;
