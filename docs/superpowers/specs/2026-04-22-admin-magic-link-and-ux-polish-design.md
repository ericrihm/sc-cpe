# Admin Magic-Link Auth + Dashboard Sign-In UX Polish

## Goal

Replace the hardcoded `ADMIN_TOKEN` paste-in login for browser users with
email-based magic-link auth. Simultaneously polish the user-facing dashboard
access flow by eliminating the "recover" framing and consolidating sign-in
onto `/dashboard.html`.

Bearer token auth stays for machine-to-machine (workers, CI, smoke tests).

## Architecture

Two independent changes that share a deploy:

1. **Admin magic-link auth** — new `admin_users` D1 table, three new API
   endpoints (`login`, `callback`, `logout`), signed `__Host-sc-admin`
   cookie, updated `isAdmin()` with cookie-first + bearer-fallback.

2. **User sign-in UX** — delete `/recover.html`, consolidate sign-in form
   onto `/dashboard.html` with friendly "Welcome back" copy, update index
   page links and error messages.

## Tech Stack

- Cloudflare Pages Functions (JS), D1, KV (nonce storage)
- Existing `email_outbox` + email-sender worker (Resend) for magic-link delivery
- HMAC-SHA256 for cookie signing (Web Crypto API, no libraries)
- Cloudflare Turnstile for login form CAPTCHA

---

## Part 1: Admin Magic-Link Auth

### Data Model

**Migration 008** adds:

```sql
CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL DEFAULT 'migration'
);

INSERT OR IGNORE INTO admin_users (email) VALUES ('ericrihm@gmail.com');
```

**New secret**: `ADMIN_COOKIE_SECRET` — 64-char hex string (32 bytes random).
Set via `wrangler pages secret put`. Stored locally at
`~/.cloudflare/sc-cpe-admin-cookie-secret`. Rotation invalidates all admin
sessions (admins re-login via email — acceptable).

### Magic-Link Token Format

No JWT library. HMAC-signed payload using Web Crypto API:

```
payload = base64url(email + "." + expires_epoch + "." + nonce)
token   = payload + "." + base64url(hmac_sha256(payload, ADMIN_COOKIE_SECRET))
```

- `nonce`: 16-byte random hex, stored in KV key `admin_nonce:{nonce}` with
  15-minute TTL. Deleted on use (single-use).
- `expires_epoch`: `Date.now() + 15 * 60 * 1000` (15 minutes).

### Session Cookie Format

Same HMAC-signed format, minus the nonce:

```
payload = base64url(email + "." + expires_epoch)
cookie  = payload + "." + base64url(hmac_sha256(payload, ADMIN_COOKIE_SECRET))
```

- Cookie name: `__Host-sc-admin` (`__Host-` prefix enforces `Secure`,
  `Path=/`, no `Domain`).
- Attributes: `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`.
- `expires_epoch`: `Date.now() + 24 * 60 * 60 * 1000` (24 hours).

### New Endpoints

#### `POST /api/admin/auth/login`

1. Validate Turnstile token.
2. Rate limit: 5 requests per IP per hour (same as user recovery).
3. Normalize email (lowercase, trim).
4. Look up email in `admin_users`.
5. If found: generate nonce, store in KV, build magic-link token, queue
   email via `email_outbox` with link to `/api/admin/auth/callback?token=...`.
6. Constant-time response regardless of match:
   `{ ok: true, message: "If that email is an admin account, we've sent a login link." }`

**Email template:**
- Subject: "SC-CPE Admin Login"
- Body: "Click to sign in to the SC-CPE admin panel. This link expires in
  15 minutes." + prominent button/link.

#### `GET /api/admin/auth/callback?token=...`

1. Parse and verify HMAC signature on token.
2. Check expiry (reject if past).
3. Check nonce exists in KV (reject if missing — already used or expired).
4. Delete nonce from KV (single-use).
5. Verify email still in `admin_users` (revocation check).
6. Set `__Host-sc-admin` cookie with signed session payload.
7. Redirect to `/admin.html` (or `redirect` query param if present,
   validated against same-origin).
8. Audit log: `admin_login` action with email and IP hash.

**Error cases:** expired link, already-used link, email removed from
`admin_users` — all redirect to `/admin.html` with `?error=expired` query
param. Admin page shows "Login link expired or already used. Request a new
one." No information leakage.

#### `POST /api/admin/auth/logout`

1. Clear `__Host-sc-admin` cookie (set `Max-Age=0`).
2. Return `{ ok: true }`.
3. No CSRF concern — clearing a cookie is not a state change that helps an
   attacker.

### Updated `isAdmin(env, request)`

New logic (order matters):

1. **Bearer token path**: if `Authorization: Bearer <token>` header present,
   do existing constant-time HMAC compare against `env.ADMIN_TOKEN`. Return
   result. (Machine-to-machine path — unchanged.)
2. **Cookie path**: if `__Host-sc-admin` cookie present, verify HMAC
   signature using `env.ADMIN_COOKIE_SECRET`, check expiry, query
   `admin_users` for the email. Return result.
3. **Neither present**: return `false`.

If `ADMIN_COOKIE_SECRET` is not set (env var missing), cookie path returns
false silently — graceful degradation to bearer-only.

### Admin Page UI Changes (`admin.html`, `analytics.html`)

Replace the current token password input with:

- Email input field + Turnstile + "Send login link" button.
- On submit: POST to `/api/admin/auth/login`.
- Success: "Check your inbox — we sent a login link."
- If already authenticated (cookie present): skip login, show admin panel
  directly.
- Add "Sign out" link in the header (POST to `/api/admin/auth/logout`).

---

## Part 2: User Sign-In UX Polish

### Pages Removed

Delete `pages/recover.html` and `pages/recover.js`.

Add a redirect file or `_redirects` entry: `/recover.html` -> `/dashboard.html`
(301). Remove after ~2 weeks.

### Dashboard Sign-In Card (`dashboard.html`)

When no token is present and no saved session exists, show:

- **Heading:** "Welcome back"
- **Subtext:** "Enter your email and we'll send you a link — no password needed."
- **Form:** Email input + Turnstile + button: "Send me my dashboard link"
- **Success state:** "Check your inbox — we sent a link to **{email}**."
  (Display the actual email they entered, bolded.)
- **Small print:** "Don't have an account? [Register here](/)"

The form POSTs to `/api/recover` (endpoint unchanged, just called from
dashboard now).

### Index Page Changes (`index.html`)

**Footer link** — change from:
> "Lost your dashboard link? Recover it here."

To:
> "Already registered? [Sign in to your dashboard](/dashboard.html)"

**Already-registered error** — change from:
> "That email is already registered. Use the recovery link below to get
> your dashboard URL."

To:
> "That email is already registered.
> [Sign in to your dashboard](/dashboard.html) to access your attendance
> and certificates."

### What Stays Unchanged

- `/api/recover` endpoint — same backend, rate limits, constant-time response.
- Recovery email template — subject "Your Simply Cyber CPE dashboard link"
  already reads correctly.
- Dashboard token mechanics, localStorage "remember this device", `?t=`
  parameter handling.
- All `/api/me/[token]/*` endpoints.

---

## Security Properties

| Property | How |
|----------|-----|
| No admin email enumeration | Login returns constant response regardless of match |
| Single-use magic links | KV nonce deleted on first use |
| Short-lived magic links | 15-min expiry in signed payload |
| Instant admin revocation | Remove email from `admin_users`; next request fails lookup |
| CSRF-safe admin cookie | `SameSite=Strict` + `__Host-` prefix |
| Bearer token unchanged | Workers, CI, smoke tests unaffected |
| Graceful degradation | Missing `ADMIN_COOKIE_SECRET` falls back to bearer-only |
| No user enumeration (recover) | Unchanged — constant-time response on `/api/recover` |

## Rollout Order

1. Deploy migration 008 (`admin_users` table, seed email).
2. Set `ADMIN_COOKIE_SECRET` secret via wrangler.
3. Deploy code (new endpoints, updated `isAdmin()`, UI changes).
4. Bearer token works throughout — zero disruption.
5. Remove `/recover.html` redirect after ~2 weeks.

## Risk Mitigation

- **Cookie secret not set**: cookie auth path returns false, bearer still
  works. No breakage.
- **Email delivery delay**: 15-min magic link window, Resend delivers in
  <30s typically. Generous margin.
- **KV nonce miss**: if KV temporarily unavailable, magic link fails. User
  retries, gets new link. Acceptable.
- **D1 query on every admin request**: one extra SELECT per request for
  cookie path. Negligible for admin traffic volume.
