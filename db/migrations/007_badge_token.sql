-- Separate badge_token for public badge/share URLs so the dashboard_token
-- (sole credential) isn't exposed when users share their achievement.
ALTER TABLE users ADD COLUMN badge_token TEXT;
UPDATE users SET badge_token = lower(hex(randomblob(32))) WHERE badge_token IS NULL;
CREATE UNIQUE INDEX users_badge_token_unique ON users(badge_token) WHERE badge_token IS NOT NULL;
