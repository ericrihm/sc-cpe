# Ops Hardening, Admin Panel UI, and PR Previews

## Goal

Three independent improvements shipped together:

1. **Durable backups + restore** — store D1 backups in R2, add a restore
   script, and validate the round-trip in CI.
2. **Admin panel UI** — surface all 5 existing admin API endpoints that
   lack UI: user search, appeals queue, cert revoke, cert resend, manual
   attendance grant.
3. **CF Pages PR previews** — create preview-environment D1/R2/KV
   bindings with seed data so PR preview deploys are functional.

## Tech Stack

- Cloudflare Pages Functions (JS), D1, R2, KV
- GitHub Actions workflows
- Existing `admin.html` / `admin.js` / `admin.css` (vanilla JS, no framework)
- `wrangler` CLI for infrastructure provisioning

---

## Part 1: Durable Backups + Restore

### Storage

New R2 bucket: `sc-cpe-backups`. Created once via:

```
wrangler r2 bucket create sc-cpe-backups
```

### Backup Workflow Changes (`backup.yml`)

After the existing `wrangler d1 export` step, add an R2 upload step:

```
wrangler r2 object put sc-cpe-backups/d1-backup-$TIMESTAMP.sql \
  --file $BACKUP_FILE
```

Keep the existing `upload-artifact` step as a secondary copy (30-day
retention via GitHub). R2 objects are retained for 90 days via lifecycle
rule.

The backup script (`scripts/backup_d1.sh`) gains an optional
`--upload-r2` flag. When set (the workflow always sets it), it uploads
to the bucket after export. Local `/tmp` cleanup stays at 4 files.

### Restore Script (`scripts/restore_d1.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   scripts/restore_d1.sh --list              # list available backups
#   scripts/restore_d1.sh --latest --confirm   # restore most recent
#   scripts/restore_d1.sh <key> --confirm      # restore specific backup

DB_NAME="sc-cpe"
BUCKET="sc-cpe-backups"
```

**Operations:**

1. `--list`: `wrangler r2 object list $BUCKET` → print keys sorted by
   date, most recent first.
2. `--latest` or explicit key: download via `wrangler r2 object get`.
3. Requires `--confirm` flag — refuses to run without it.
4. Applies via `wrangler d1 execute $DB_NAME --remote --file <path>`.
5. Runs a sanity query after restore:
   `SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM audit_log;`

### Restore Test (CI)

The backup workflow gains a `workflow_dispatch` input `test_restore`
(boolean, default false). When true, after backup + upload:

1. Create throwaway D1: `wrangler d1 create sc-cpe-restore-test`.
2. Apply migrations from `db/migrations/`.
3. Import the backup SQL.
4. Run sanity queries (`SELECT COUNT(*) FROM users`, etc.).
5. Delete the throwaway DB: `wrangler d1 delete sc-cpe-restore-test --force`.

This validates the round-trip without touching production.

### Documentation

Add "Disaster Recovery" section to `docs/RUNBOOK.md` covering:
- How backups work (weekly, R2 + GitHub artifacts)
- How to list and restore from R2
- How to trigger a restore test
- Expected restore time and data loss window (up to 7 days)

---

## Part 2: Admin Panel UI

### Overview

Five new UI sections in `admin.html`, wired to existing API endpoints
via the existing `fetchJson()` helper (cookie + bearer dual-path auth).
All follow the existing card/table patterns in `admin.css`.

### 2.1 User Search

**Location:** New section after the cert feedback table.

**UI elements:**
- Section header: "Users"
- Search input with placeholder "Search by name, email, channel, or ID..."
- Submit button: "Search"
- Results table: Name, Email, State, YouTube Channel, Attendance, Certs,
  Open Appeals, Actions

**API:** `GET /api/admin/users?q={query}&limit=20`

**Actions column per row:**
- "View certs" — expands inline to show user's certs (new API call:
  query certs by user_id, reuse the existing cert data from user search
  response's `cert_count` as a hint, but fetch full cert list on expand)
- "Grant attendance" — opens the manual attendance form pre-filled with
  `user_id`

**Cert sub-rows** (expanded inline under a user):
- Table: Period, Kind, State, CPE, Public Token (truncated), Actions
- Actions: "Resend email" button, "Revoke" button, "Re-issue" button
- Each calls the corresponding existing API endpoint

Note: the user search API already returns `attendance_count`,
`cert_count`, and `open_appeal_count` as aggregates — no new endpoints
needed.

**New endpoint needed:** `GET /api/admin/user/{id}/certs` — returns all
certs for a user. This is a small addition (one SQL query, admin-gated).

### 2.2 Appeals Queue

**Location:** New section after Users.

**UI elements:**
- Section header: "Appeals" with count badge
- State filter: dropdown (open / granted / denied / any), default "open"
- Results table: Date, User, Claimed Date, Stream, Evidence, State, Actions

**API:** `GET /api/admin/appeals?state={state}&limit=50`

**Actions (for open appeals):**
- "Grant" button — prompts for notes, resolver handle, and rule_version;
  calls `POST /api/admin/appeals/{id}/resolve` with
  `{ decision: "grant", notes: "...", resolver: "...", rule_version: 1 }`
- "Deny" button — same endpoint with `{ decision: "deny", notes, resolver }`

**Resolved appeals:** show resolution notes, resolver, resolved_at.
No action buttons.

### 2.3 Cert Revoke

**Accessed two ways:**

1. **Standalone form** — small form in the Users section header area:
   public_token input + reason textarea + "Revoke" button.
2. **Inline button** — "Revoke" on cert sub-rows under user search results.
   Pre-fills the public_token; prompts for reason.

**API:** `POST /api/admin/revoke` with `{ public_token, reason }`

**Confirmation:** `confirm()` dialog before sending. Shows the token and
asks for the reason.

**Response handling:** Shows success with `revoked_at`, or
`already_revoked` if idempotent hit.

### 2.4 Cert Resend

**Access:** "Resend email" button on cert sub-rows under user search.

**API:** `POST /api/admin/cert/{public_token}/resend`

**Confirmation:** `confirm()` dialog: "Resend cert email to {email}?"

**Response:** Button changes to "Sent" on success, shows error on failure.

### 2.5 Manual Attendance Grant

**Access:** "Grant attendance" button on user search rows, or standalone
form in the appeals section.

**UI elements:** Form with:
- User ID (pre-filled from user search, or manual entry)
- Stream ID (manual entry — could add a stream picker later, YAGNI for now)
- Reason (required, textarea)
- Resolver handle (text input)
- Rule version (number input, default 1)

**API:** `POST /api/admin/attendance` with
`{ user_id, stream_id, reason, resolver, rule_version }`

**Response:** Shows success with earned CPE, or error (attendance already
recorded, user not found, etc.).

### New API Endpoint

**`GET /api/admin/user/{id}/certs`**

Returns all certs for a user, ordered by `created_at DESC`. Fields:
`id`, `public_token`, `period_yyyymm`, `cert_kind`, `stream_id`,
`cpe_total`, `sessions_count`, `state`, `revoked_at`,
`revocation_reason`, `created_at`, `supersedes_cert_id`.

Auth: admin-gated (same as all `/api/admin/*` endpoints).

### UI Layout

The admin page sections, top to bottom:
1. Overview (existing)
2. Kill switches (existing)
3. Heartbeats (existing)
4. Audit chain (existing)
5. Users (new — search + cert sub-rows with revoke/resend/reissue)
6. Appeals (new — queue with grant/deny)
7. Manual attendance (new — standalone form)
8. Audit trail (existing)
9. Cert feedback (existing)

### Toggle Auth for POST Requests

The existing toggle POST in `admin.js` uses `Authorization: Bearer`
header directly. New POST actions must use the same `fetchJson()`
dual-path pattern (cookie + bearer). Add a `postJson(path, body)` helper
that mirrors `fetchJson()` but does `method: "POST"` with JSON body and
`credentials: "include"`.

---

## Part 3: CF Pages PR Previews

### Infrastructure (one-time setup)

Create these resources manually:

```bash
wrangler d1 create sc-cpe-preview
wrangler kv:namespace create sc-cpe-rate-preview
wrangler r2 bucket create sc-cpe-certs-preview
```

Record the IDs in `wrangler.toml` under `[env.preview]`.

### Wrangler Config

Add to `pages/wrangler.toml`:

```toml
[env.preview]
# Preview bindings — separate from production
[[env.preview.d1_databases]]
binding = "DB"
database_name = "sc-cpe-preview"
database_id = "<preview-d1-id>"

[[env.preview.kv_namespaces]]
binding = "RATE_KV"
id = "<preview-kv-id>"

[[env.preview.r2_buckets]]
binding = "CERTS_BUCKET"
bucket_name = "sc-cpe-certs-preview"
```

CF Pages automatically uses the `preview` environment for non-production
branch deploys.

### Seed Data (`db/seed-preview.sql`)

Minimal fixture set:

```sql
-- Admin user
INSERT OR IGNORE INTO admin_users (email) VALUES ('ericrihm@gmail.com');

-- Test users
INSERT OR IGNORE INTO users (id, email, legal_name, dashboard_token,
  badge_token, state, created_at)
VALUES
  ('TEST_USER_ACTIVE_001', 'testuser@example.com', 'Test User',
   'preview-dash-token-001', 'preview-badge-token-001', 'active',
   '2026-04-01T00:00:00Z'),
  ('TEST_USER_PENDING_001', 'pending@example.com', 'Pending User',
   'preview-dash-token-002', 'preview-badge-token-002',
   'pending_verification', '2026-04-15T00:00:00Z');

-- Streams
INSERT OR IGNORE INTO streams (id, yt_video_id, title, scheduled_date,
  actual_start_at, ended_at, created_at)
VALUES
  ('STREAM_001', 'dQw4w9WgXcQ', 'Daily Threat Briefing — Apr 1',
   '2026-04-01', '2026-04-01T12:00:00Z', '2026-04-01T13:00:00Z',
   '2026-04-01T11:00:00Z'),
  ('STREAM_002', 'dQw4w9WgXcQ', 'Daily Threat Briefing — Apr 2',
   '2026-04-02', '2026-04-02T12:00:00Z', '2026-04-02T13:00:00Z',
   '2026-04-02T11:00:00Z');

-- Attendance
INSERT OR IGNORE INTO attendance (user_id, stream_id, earned_cpe,
  first_msg_id, first_msg_at, first_msg_sha256, first_msg_len,
  rule_version, source, created_at)
VALUES
  ('TEST_USER_ACTIVE_001', 'STREAM_001', 0.5,
   'preview-msg-001', '2026-04-01T12:05:00Z', '', 0, 1, 'poll',
   '2026-04-01T12:05:00Z'),
  ('TEST_USER_ACTIVE_001', 'STREAM_002', 0.5,
   'preview-msg-002', '2026-04-02T12:05:00Z', '', 0, 1, 'poll',
   '2026-04-02T12:05:00Z');

-- KV config
INSERT OR IGNORE INTO kv (k, v) VALUES
  ('rule_version.current', '1'),
  ('rule_version.1.cpe_per_day', '0.5'),
  ('rule_version.1.pre_start_grace_min', '15');
```

### Preview Deploy Workflow (`.github/workflows/deploy-preview.yml`)

Triggered on `pull_request` (opened, synchronize, reopened).

Steps:
1. Apply all migrations from `db/migrations/` to the preview D1.
2. Apply `db/seed-preview.sql` (idempotent via `INSERT OR IGNORE`).
3. Deploy Pages: `wrangler pages deploy . --project-name sc-cpe-web
   --branch ${{ github.head_ref }}`.
4. Comment on the PR with the preview URL.

No smoke suite — preview is best-effort.

### Secrets

- `TURNSTILE_SECRET_KEY` — shared (Turnstile works on any origin)
- `ADMIN_COOKIE_SECRET` — shared (different origin means cookies don't
  collide)
- `ADMIN_TOKEN` — use production value (preview is internal-only)
- All set on the `production` environment in GitHub Actions (already
  available)

### What This Unlocks

- Click through the full user flow (register → verify → dashboard → certs)
  in preview with test data
- Test admin panel changes against real D1 queries
- Verify new migrations before they hit production
- Review UI changes in the actual CF Pages environment (not just local)

---

## Rollout Order

1. **Backup/Restore** — no code dependencies, purely ops
2. **Admin Panel UI** — one new endpoint + HTML/JS/CSS changes
3. **PR Previews** — infrastructure setup + workflow

Each ships independently. A failure in one doesn't block the others.

## Risk Mitigation

- **Restore script safety:** `--confirm` flag required. Sanity queries
  after restore catch silent corruption.
- **Admin UI auth:** All new UI actions use the existing `fetchJson()`
  / `postJson()` pattern with cookie+bearer dual-path. No new auth
  surface.
- **Preview data isolation:** Completely separate D1/R2/KV. No
  cross-contamination with production.
- **Preview secrets:** Using production secrets for preview is acceptable
  because preview deploys are only triggered by PRs (repo collaborators
  only) and the preview URL is not indexed.
