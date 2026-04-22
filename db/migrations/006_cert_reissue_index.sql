-- Allow cert reissue without unique-index conflict: exclude 'regenerated'
-- from the partial unique indexes so the old cert can be marked regenerated
-- before the new pending row is inserted.
DROP INDEX IF EXISTS certs_user_period_bundled_unique;
CREATE UNIQUE INDEX certs_user_period_bundled_unique
    ON certs(user_id, period_yyyymm)
    WHERE cert_kind = 'bundled' AND state NOT IN ('revoked', 'regenerated');

DROP INDEX IF EXISTS certs_user_stream_unique;
CREATE UNIQUE INDEX certs_user_stream_unique
    ON certs(user_id, stream_id)
    WHERE cert_kind = 'per_session'
      AND stream_id IS NOT NULL
      AND state NOT IN ('revoked', 'regenerated');
