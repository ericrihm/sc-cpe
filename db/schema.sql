-- SC-CPE D1 schema. SQLite dialect (Cloudflare D1).
-- All timestamps are ISO 8601 UTC strings (e.g. '2026-04-14T13:45:00Z').
-- All primary IDs are 26-char Crockford base32 ULIDs unless noted.
-- Raw chat text is NOT stored here; it lives in R2 JSONL with 7-day TTL.
-- This DB retains yt_message_id + SHA-256 hash for evidentiary defensibility.

PRAGMA foreign_keys = ON;

-- Registered users. One row per person.
CREATE TABLE users (
    id                    TEXT PRIMARY KEY,
    email                 TEXT NOT NULL,
    legal_name            TEXT NOT NULL,
    yt_channel_id         TEXT,
    yt_display_name_seen  TEXT,
    verification_code     TEXT,
    code_expires_at       TEXT,
    dashboard_token       TEXT NOT NULL,
    state                 TEXT NOT NULL DEFAULT 'pending_verification',
    email_prefs           TEXT NOT NULL DEFAULT '{"monthly_cert":true}',
    legal_name_attested   INTEGER NOT NULL DEFAULT 0,
    age_attested_13plus   INTEGER NOT NULL DEFAULT 0,
    tos_version_accepted  TEXT,
    created_at            TEXT NOT NULL,
    verified_at           TEXT,
    deleted_at            TEXT,
    CHECK (state IN ('pending_verification','active','inactive','banned','deleted','expired')),
    show_on_leaderboard   INTEGER NOT NULL DEFAULT 0,
    CHECK (legal_name_attested IN (0,1)),
    CHECK (age_attested_13plus IN (0,1)),
    CHECK (show_on_leaderboard IN (0,1))
);
CREATE UNIQUE INDEX users_email_unique ON users(lower(email)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_channel_unique ON users(yt_channel_id) WHERE yt_channel_id IS NOT NULL AND state = 'active';
CREATE UNIQUE INDEX users_code_unique ON users(verification_code) WHERE verification_code IS NOT NULL;
CREATE UNIQUE INDEX users_dashboard_token_unique ON users(dashboard_token);

-- Livestream sessions. One row per YouTube video (not per calendar date).
CREATE TABLE streams (
    id                    TEXT PRIMARY KEY,
    yt_video_id           TEXT NOT NULL UNIQUE,
    yt_live_chat_id       TEXT,
    title                 TEXT,
    scheduled_date        TEXT,
    actual_start_at       TEXT,
    actual_end_at         TEXT,
    window_start_at       TEXT,
    window_end_at         TEXT,
    state                 TEXT NOT NULL DEFAULT 'detected',
    skip_reason           TEXT,
    flag_reason           TEXT,
    messages_scanned      INTEGER NOT NULL DEFAULT 0,
    distinct_attendees    INTEGER NOT NULL DEFAULT 0,
    raw_r2_key            TEXT,
    raw_purge_after       TEXT,
    created_at            TEXT NOT NULL,
    CHECK (state IN ('detected','live','complete','skipped','flagged','rescanned'))
);
CREATE INDEX streams_date_idx ON streams(scheduled_date);

-- Attendance credits. One row per user per stream. Message evidence attached.
CREATE TABLE attendance (
    user_id               TEXT NOT NULL,
    stream_id             TEXT NOT NULL,
    earned_cpe            REAL NOT NULL DEFAULT 0.5,
    first_msg_id          TEXT NOT NULL,
    first_msg_at          TEXT NOT NULL,
    first_msg_sha256      TEXT NOT NULL,
    first_msg_len         INTEGER NOT NULL,
    rule_version          INTEGER NOT NULL,
    source                TEXT NOT NULL DEFAULT 'poll',
    created_at            TEXT NOT NULL,
    PRIMARY KEY (user_id, stream_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (stream_id) REFERENCES streams(id),
    CHECK (source IN ('poll','appeal_granted','admin_manual')),
    CHECK (earned_cpe >= 0 AND earned_cpe <= 1)
);
CREATE INDEX attendance_user_idx ON attendance(user_id);
CREATE INDEX attendance_stream_idx ON attendance(stream_id);

-- Issued certificates. UNIQUE(user_id, period_yyyymm) prevents double-issue.
-- Issuer / name / signing cert fingerprint snapshotted at issuance.
-- Column order reflects migration history: cert_kind and stream_id were
-- appended via ALTER TABLE (migrations 003 + per-session work), and the
-- stream_id FK lives inline because SQLite ALTER TABLE can't add a
-- separate FOREIGN KEY clause. Keep in sync with the live sqlite_master
-- representation or scripts/check_schema.sh --http reports drift.
CREATE TABLE certs (
    id                    TEXT PRIMARY KEY,
    public_token          TEXT NOT NULL UNIQUE,
    user_id               TEXT NOT NULL,
    period_yyyymm         TEXT NOT NULL,
    period_start          TEXT NOT NULL,
    period_end            TEXT NOT NULL,
    cpe_total             REAL NOT NULL,
    sessions_count        INTEGER NOT NULL,
    session_video_ids     TEXT NOT NULL,
    issuer_name_snapshot  TEXT NOT NULL,
    recipient_name_snapshot TEXT NOT NULL,
    signing_cert_sha256   TEXT,
    pdf_r2_key            TEXT,
    pdf_sha256            TEXT,
    state                 TEXT NOT NULL DEFAULT 'pending',
    revocation_reason     TEXT,
    revoked_at            TEXT,
    supersedes_cert_id    TEXT,
    generated_at          TEXT,
    delivered_at          TEXT,
    first_viewed_at       TEXT,
    created_at            TEXT NOT NULL,
    cert_kind             TEXT NOT NULL DEFAULT 'bundled',
    stream_id             TEXT REFERENCES streams(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (supersedes_cert_id) REFERENCES certs(id),
    CHECK (state IN ('pending','generated','delivered','viewed_by_auditor','revoked','regenerated')),
    CHECK (length(public_token) >= 32)
);
-- cert_kind domain ('bundled' | 'per_session') enforced by app code; SQLite
-- can't ADD CONSTRAINT CHECK on ALTER so migration 003 leaves it off.
CREATE UNIQUE INDEX certs_user_period_bundled_unique
    ON certs(user_id, period_yyyymm)
    WHERE cert_kind = 'bundled' AND state != 'revoked';
CREATE UNIQUE INDEX certs_user_stream_unique
    ON certs(user_id, stream_id)
    WHERE cert_kind = 'per_session'
      AND stream_id IS NOT NULL
      AND state != 'revoked';
CREATE INDEX certs_user_idx ON certs(user_id);
CREATE INDEX certs_kind_idx ON certs(cert_kind);
CREATE INDEX certs_pending_idx ON certs(state) WHERE state = 'pending';

-- User-submitted claims for missed attendance. Admin resolves manually in MVP.
CREATE TABLE appeals (
    id                    TEXT PRIMARY KEY,
    user_id               TEXT NOT NULL,
    claimed_date          TEXT NOT NULL,
    claimed_stream_id     TEXT,
    approx_msg_time       TEXT,
    yt_display_name_used  TEXT,
    evidence_text         TEXT,
    evidence_url          TEXT,
    state                 TEXT NOT NULL DEFAULT 'open',
    resolution_notes      TEXT,
    resolved_by           TEXT,
    resolved_at           TEXT,
    created_at            TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (claimed_stream_id) REFERENCES streams(id),
    CHECK (state IN ('open','granted','denied','cancelled'))
);
CREATE INDEX appeals_user_idx ON appeals(user_id);
CREATE INDEX appeals_state_idx ON appeals(state) WHERE state = 'open';

-- Durable email queue. Idempotency key prevents duplicate sends on retry.
CREATE TABLE email_outbox (
    id                    TEXT PRIMARY KEY,
    user_id               TEXT,
    template              TEXT NOT NULL,
    to_email              TEXT NOT NULL,
    subject               TEXT NOT NULL,
    payload_json          TEXT NOT NULL,
    idempotency_key       TEXT NOT NULL UNIQUE,
    state                 TEXT NOT NULL DEFAULT 'queued',
    attempts              INTEGER NOT NULL DEFAULT 0,
    last_error            TEXT,
    resend_message_id     TEXT,
    created_at            TEXT NOT NULL,
    sent_at               TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    CHECK (state IN ('queued','sending','sent','failed','bounced'))
);
CREATE INDEX email_outbox_state_idx ON email_outbox(state) WHERE state IN ('queued','sending');

-- Append-only audit trail. Every state transition writes here.
-- NEVER UPDATE OR DELETE rows in this table.
-- Rows are hash-chained: prev_hash = SHA-256 of the prior row's canonical JSON
-- (see db/migrations/001_audit_hash_chain.sql). Genesis row has prev_hash=NULL.
CREATE TABLE audit_log (
    id                    TEXT PRIMARY KEY,
    actor_type            TEXT NOT NULL,
    actor_id              TEXT,
    action                TEXT NOT NULL,
    entity_type           TEXT NOT NULL,
    entity_id             TEXT NOT NULL,
    before_json           TEXT,
    after_json            TEXT,
    ip_hash               TEXT,
    user_agent            TEXT,
    ts                    TEXT NOT NULL,
    prev_hash             TEXT,
    CHECK (actor_type IN ('system','user','admin','poller','cron','api'))
);
CREATE INDEX audit_entity_idx ON audit_log(entity_type, entity_id);
CREATE INDEX audit_ts_idx ON audit_log(ts);
-- Hash-chain integrity: prevents two writers from forking on the same tip.
CREATE UNIQUE INDEX audit_prev_hash_unique
    ON audit_log(prev_hash) WHERE prev_hash IS NOT NULL;
-- At most one genesis row (see migration 001 for rationale).
CREATE UNIQUE INDEX audit_genesis_once
    ON audit_log(COALESCE(prev_hash, 'GENESIS')) WHERE prev_hash IS NULL;

-- Poller heartbeat. Separate "watchdog" Worker reads this to detect silent failure.
CREATE TABLE heartbeats (
    source                TEXT PRIMARY KEY,
    last_beat_at          TEXT NOT NULL,
    last_status           TEXT NOT NULL,
    detail_json           TEXT,
    CHECK (last_status IN ('ok','warn','error'))
);

-- Key-value for small runtime state (cached liveChatId for the day, rule_version, etc.)
CREATE TABLE kv (
    k                     TEXT PRIMARY KEY,
    v                     TEXT NOT NULL,
    expires_at            TEXT,
    updated_at            TEXT NOT NULL
);

-- Links shared by host/moderators during the Daily Threat Briefing.
CREATE TABLE show_links (
    id            TEXT PRIMARY KEY,
    stream_id     TEXT NOT NULL REFERENCES streams(id),
    url           TEXT NOT NULL,
    domain        TEXT NOT NULL,
    title         TEXT,
    description   TEXT,
    author_type   TEXT NOT NULL DEFAULT 'owner',
    author_name   TEXT NOT NULL,
    yt_channel_id TEXT NOT NULL,
    yt_message_id TEXT NOT NULL,
    posted_at     TEXT NOT NULL,
    enriched_at   TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

    UNIQUE(stream_id, url)
);
CREATE INDEX idx_show_links_stream ON show_links(stream_id);
CREATE INDEX idx_show_links_enriched ON show_links(enriched_at) WHERE enriched_at IS NULL;

-- Cert-correctness feedback. See db/migrations/002_cert_feedback.sql for rationale.
CREATE TABLE cert_feedback (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    cert_id         TEXT NOT NULL,
    rating          TEXT NOT NULL,
    note            TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (cert_id) REFERENCES certs(id),
    CHECK (rating IN ('ok','typo','wrong')),
    CHECK (note IS NULL OR length(note) <= 500)
);
CREATE UNIQUE INDEX cert_feedback_unique ON cert_feedback(user_id, cert_id);
CREATE INDEX cert_feedback_rating_idx ON cert_feedback(rating) WHERE rating != 'ok';

-- Deploy-pipeline migration tracking (not app data).
CREATE TABLE _applied_migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
