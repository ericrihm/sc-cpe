-- Email suppression list. Hard bounces and spam complaints from Resend webhooks
-- cause the recipient address to be inserted here; the email-sender skips any
-- outbox row whose to_email matches a suppression entry.
CREATE TABLE email_suppression (
    email       TEXT NOT NULL,
    reason      TEXT NOT NULL,
    event_id    TEXT,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (email)
);
