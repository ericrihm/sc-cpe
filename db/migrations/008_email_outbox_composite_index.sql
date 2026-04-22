-- Composite index for the email-sender's ORDER BY created_at query.
-- Replaces the state-only partial index with (state, created_at) so the
-- drainer avoids a sort step on every tick.
DROP INDEX IF EXISTS email_outbox_state_idx;
CREATE INDEX email_outbox_state_created_idx
    ON email_outbox(state, created_at)
    WHERE state IN ('queued', 'sending');
