-- Denormalized streak columns. Updated by the poller on each attendance credit.
-- Avoids O(N) attendance scan on every dashboard/leaderboard/profile read.
ALTER TABLE users ADD COLUMN current_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN longest_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_attendance_date TEXT;
