-- Add opt-in flag for the community leaderboard. Default false so existing
-- users don't appear without consent.
ALTER TABLE users ADD COLUMN show_on_leaderboard INTEGER NOT NULL DEFAULT 0;
