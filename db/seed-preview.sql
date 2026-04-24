-- Seed data for the CF Pages preview environment.
-- All INSERTs use OR IGNORE so the file is idempotent (safe to re-run).

-- Admin user
INSERT OR IGNORE INTO admin_users (email) VALUES ('ericrihm@gmail.com');

-- Test users
INSERT OR IGNORE INTO users
  (id, email, legal_name, dashboard_token, badge_token, state,
   verification_code, code_expires_at, legal_name_attested,
   age_attested_13plus, tos_version_accepted, created_at, verified_at)
VALUES
  ('01JPREVIEW00ACTIVEUSER001', 'testuser@example.com', 'Test User',
   'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
   'b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6b1b2',
   'active', NULL, NULL, 1, 1, 'v1',
   '2026-04-01T00:00:00Z', '2026-04-01T01:00:00Z'),
  ('01JPREVIEW00PENDINGUSER01', 'pending@example.com', 'Pending User',
   'c1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6c1c2',
   'd1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6d1d2',
   'pending_verification', 'PREVW001', '2026-12-31T00:00:00Z', 1, 1, 'v1',
   '2026-04-15T00:00:00Z', NULL);

-- Streams
INSERT OR IGNORE INTO streams
  (id, yt_video_id, title, scheduled_date, actual_start_at, actual_end_at,
   state, messages_scanned, distinct_attendees, created_at)
VALUES
  ('01JPREVIEWSTREAM00000001', 'prev1ewV1deo1d', 'Daily Threat Briefing — Preview Apr 1',
   '2026-04-01', '2026-04-01T12:00:00Z', '2026-04-01T13:00:00Z',
   'complete', 42, 1, '2026-04-01T11:00:00Z'),
  ('01JPREVIEWSTREAM00000002', 'prev1ewV1deo2d', 'Daily Threat Briefing — Preview Apr 2',
   '2026-04-02', '2026-04-02T12:00:00Z', '2026-04-02T13:00:00Z',
   'complete', 38, 1, '2026-04-02T11:00:00Z');

-- Attendance
INSERT OR IGNORE INTO attendance
  (user_id, stream_id, earned_cpe, first_msg_id, first_msg_at,
   first_msg_sha256, first_msg_len, rule_version, source, created_at)
VALUES
  ('01JPREVIEW00ACTIVEUSER001', '01JPREVIEWSTREAM00000001', 0.5,
   'preview-msg-001', '2026-04-01T12:05:00Z',
   'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 0,
   1, 'poll', '2026-04-01T12:05:00Z'),
  ('01JPREVIEW00ACTIVEUSER001', '01JPREVIEWSTREAM00000002', 0.5,
   'preview-msg-002', '2026-04-02T12:05:00Z',
   'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 0,
   1, 'poll', '2026-04-02T12:05:00Z');

-- KV config
INSERT OR IGNORE INTO kv (k, v, updated_at) VALUES
  ('rule_version.current', '1', '2026-04-01T00:00:00Z'),
  ('rule_version.1.cpe_per_day', '0.5', '2026-04-01T00:00:00Z'),
  ('rule_version.1.pre_start_grace_min', '15', '2026-04-01T00:00:00Z');
