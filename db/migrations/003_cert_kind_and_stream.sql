-- Adds cert_kind + stream_id to certs. Two cert shapes:
--   'bundled'     — one per (user, period_yyyymm), session list on the PDF.
--                   Legacy default; existing rows get this via ADD COLUMN default.
--   'per_session' — one per (user, stream), single date/video on the PDF.
--                   stream_id is required; period_yyyymm still set to the
--                   session's YYYYMM so monthly rollups stay cheap.
--
-- The monolithic UNIQUE(user_id, period_yyyymm) is replaced by two kind-scoped
-- partial uniques so bundled + N per_session certs for the same user/month
-- coexist without conflict. SQLite can't ADD CONSTRAINT CHECK, so cert_kind
-- domain enforcement lives in application code (services/certs/generate.py
-- and pages/functions/api/**).

ALTER TABLE certs ADD COLUMN cert_kind TEXT NOT NULL DEFAULT 'bundled';
ALTER TABLE certs ADD COLUMN stream_id TEXT REFERENCES streams(id);

DROP INDEX IF EXISTS certs_user_period_unique;

CREATE UNIQUE INDEX IF NOT EXISTS certs_user_period_bundled_unique
    ON certs(user_id, period_yyyymm)
 WHERE cert_kind = 'bundled' AND state != 'revoked';

CREATE UNIQUE INDEX IF NOT EXISTS certs_user_stream_unique
    ON certs(user_id, stream_id)
 WHERE cert_kind = 'per_session'
   AND stream_id IS NOT NULL
   AND state != 'revoked';

CREATE INDEX IF NOT EXISTS certs_kind_idx ON certs(cert_kind);
CREATE INDEX IF NOT EXISTS certs_pending_idx ON certs(state) WHERE state = 'pending';
