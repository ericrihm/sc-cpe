-- WebAuthn passkey credentials for admin users.
CREATE TABLE IF NOT EXISTS admin_passkeys (
    id TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admin_users(id),
    credential_id TEXT NOT NULL UNIQUE,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    backed_up INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
);

ALTER TABLE admin_users ADD COLUMN invited_by INTEGER REFERENCES admin_users(id);
ALTER TABLE admin_users ADD COLUMN display_name TEXT;

UPDATE admin_users SET role = 'owner' WHERE email = 'ericrihm@gmail.com';
