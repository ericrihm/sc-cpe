-- Cert-correctness feedback. Collected via the dashboard; drives the
-- product improvement loop (are issued certs actually correct, or do
-- recipients hit typos / missing attendance / wrong totals?).
--
-- One row per (user, cert) submission. Re-submitting overwrites via the
-- UNIQUE constraint + UPSERT in the endpoint — users change their mind,
-- we want the latest. No PII stored beyond the rating and a bounded note.

CREATE TABLE IF NOT EXISTS cert_feedback (
    id              TEXT PRIMARY KEY,        -- ULID
    user_id         TEXT NOT NULL,
    cert_id         TEXT NOT NULL,
    rating          TEXT NOT NULL,           -- 'ok' | 'typo' | 'wrong'
    note            TEXT,                    -- optional, <= 500 chars
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (cert_id) REFERENCES certs(id),
    CHECK (rating IN ('ok','typo','wrong')),
    CHECK (note IS NULL OR length(note) <= 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS cert_feedback_unique ON cert_feedback(user_id, cert_id);
CREATE INDEX IF NOT EXISTS cert_feedback_rating_idx ON cert_feedback(rating) WHERE rating != 'ok';
