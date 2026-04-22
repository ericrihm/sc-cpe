-- Admin users for magic-link authentication.
-- Bearer token (ADMIN_TOKEN) stays for machine-to-machine auth.
CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL DEFAULT 'migration'
);

INSERT OR IGNORE INTO admin_users (email) VALUES ('ericrihm@gmail.com');
