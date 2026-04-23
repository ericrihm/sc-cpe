-- Add discord_user_id to users for Discord-based verification and attendance.
-- Users link their Discord identity by posting their SC-CPE code in
-- the #live-chat Discord channel. Once linked, the Discord rescan can
-- credit attendance from Discord messages.
ALTER TABLE users ADD COLUMN discord_user_id TEXT;
CREATE UNIQUE INDEX users_discord_unique ON users(discord_user_id)
    WHERE discord_user_id IS NOT NULL AND state = 'active';
