# Ship Confidence — Cross-Dimension Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Five surgical improvements — one per dimension (testing, admin UX, dashboard UX, ops, docs) — that prove the system works end-to-end, give operators visibility into problem areas, and prevent silent failures.

**Architecture:** All items are independent and touch separate subsystems. No item depends on another. Migration 013 adds `suspended_at` to users. Two new admin endpoints, one new user endpoint, one new workflow, one new test file, one RUNBOOK update.

**Tech stack:** Cloudflare Pages Functions (JS), D1 (SQLite), KV rate-limiting, GitHub Actions, existing mock-DB test pattern.

---

## 1. E2E Integration Test

### Problem

283 unit tests prove individual endpoints work in isolation. Zero tests prove they compose correctly. A regression in response shape, DB schema drift, or cross-endpoint data contract would pass every existing test.

### Design

A single test file `scripts/test_e2e.mjs` that exercises the full pipeline using handler-level calls against mock DB/KV/R2 — no network, no deployed environment.

**Golden path tested:**

1. `POST /api/register` — creates user with `state='pending_verification'`, returns 200
2. Simulate verification by flipping mock user to `state='active'` with `yt_channel_id` set
3. `GET /api/me/{token}` — returns user with active state, empty attendance/certs arrays
4. Simulate poller crediting attendance by inserting mock attendance + stream rows
5. `GET /api/me/{token}` — now returns attendance array with the credited stream
6. Simulate cert generation by inserting mock cert row with `state='generated'`
7. `GET /api/me/{token}` — returns cert in certs array with `public_token`
8. `GET /api/verify/{public_token}` — returns `valid: true` with cert metadata

**Failure path tested:**

9. `GET /api/me/{token}` for an unknown token — returns 404
10. `GET /api/verify/{public_token}` for a revoked cert — returns `valid: false`

**Mock strategy:** Reuse the `mockDB(rules)` pattern from `onboarding.test.mjs`. Each step updates the mock rules array to reflect the state change that would have happened in production (poller writing attendance, cert cron writing cert row). This tests the handler contracts, not the write paths — those are tested individually elsewhere.

**Integration:** Wire `scripts/test_e2e.mjs` into `scripts/test.sh`.

### Files

- **Create:** `scripts/test_e2e.mjs`
- **Modify:** `scripts/test.sh` (add the new test file to the `node --test` list)

---

## 2. Admin Email Suppression UI + User Suspension

### 2a. Email Suppression Admin UI

#### Problem

The `email_suppression` table (migration 012) captures hard bounces and complaints, but admins have no visibility into it. Diagnosing "user never got their cert email" requires a raw D1 query.

#### Design

**New endpoint:** `GET /api/admin/email-suppression`

- Bearer-token authenticated (standard admin pattern)
- Returns `{ suppressions: [{ email_masked, reason, event_id, created_at }] }`
- `email_masked` = first 3 chars + `***@` + domain (e.g. `eri***@gmail.com`) — enough for admin identification without PII exposure in the UI
- Query: `SELECT email, reason, event_id, created_at FROM email_suppression ORDER BY created_at DESC LIMIT 100`
- Rate limited: 60/hr per bearer

**New endpoint:** `DELETE /api/admin/email-suppression`

- Bearer-token authenticated
- Body: `{ "email": "full-email@example.com" }`
- Deletes from `email_suppression` WHERE email matches
- Audit logs: action `suppression_removed`, entity_type `email`, entity_id = email SHA-256
- Returns `{ ok: true }` or `{ error: "not_found" }` (404)
- Use case: false-positive bounce — admin verifies the address is valid and removes suppression

**Admin UI:** New "Email Suppression" section in `admin.html` after the "War Room" section.
- Table with columns: Email (masked), Reason, Event ID, Date, Action (Unsuppress button)
- Unsuppress button: `confirm("Remove suppression for this address?")`, calls DELETE endpoint
- Data loaded in the existing `load()` Promise.all batch
- If table is empty, show "No suppressed addresses."

### 2b. User Suspension

#### Problem

No mechanism to prevent a compromised or abusive account from earning CPE. The only option is revoking individual certs after the fact. Admin needs a forward-looking "stop this account from accruing benefits" toggle.

#### Design

**Migration 013:** `ALTER TABLE users ADD COLUMN suspended_at TEXT;`

When `suspended_at IS NOT NULL`:
- **Poller:** Skips attendance credit for this user (checks before INSERT into attendance). The user's chat messages are still scanned for race detection, but no CPE row is written.
- **Dashboard:** `GET /api/me/{token}` returns `suspended: true` in the user object. Dashboard shows a banner: "Your account has been suspended. Contact support for more information." All existing data (attendance, certs) remains visible but no new per-session cert requests are accepted.
- **Cert generation:** Python cron's `ELIGIBLE_SQL` (line 1139 of `generate.py`) and `ELIGIBLE_PER_SESSION_SQL` (line 1156) both filter on `u.state = 'active' AND u.deleted_at IS NULL`. Add `AND u.suspended_at IS NULL` after `u.deleted_at IS NULL` in both queries.
- **Registration:** No change — suspension is post-verification only.

**New endpoint:** `POST /api/admin/suspend`

- Bearer-token authenticated
- Body: `{ "user_id": "...", "suspended": true|false, "reason": "..." }`
- `suspended: true` → sets `suspended_at = NOW()`, audit logs action `user_suspended`
- `suspended: false` → sets `suspended_at = NULL`, audit logs action `user_unsuspended`
- Reason stored in audit log `after_json`, not on the users table
- Returns `{ ok: true, user_id, suspended_at }` or 404

**Admin UI:** User search results already show user cards. Add a "Suspend" / "Unsuspend" button to each user card (red/green toggle). Button calls `POST /api/admin/suspend` with `confirm()` gate. Suspended users show a red "SUSPENDED" pill next to their name in search results.

**Poller change:** In the attendance-crediting path in `workers/poller/src/index.js`, after looking up the user, check `suspended_at`. If set, skip the INSERT, log an audit entry `attendance_skipped_suspended`, and continue to the next message.

### Files

- **Create:** `pages/functions/api/admin/email-suppression.js`
- **Create:** `pages/functions/api/admin/suspend.js`
- **Create:** `db/migrations/013_user_suspension.sql`
- **Modify:** `db/schema.sql` (add `suspended_at` column to users table)
- **Modify:** `pages/admin.html` (suppression section + suspend button on user cards)
- **Modify:** `pages/admin.js` (render suppression table, suspend/unsuspend handlers)
- **Modify:** `workers/poller/src/index.js` (check `suspended_at` before crediting)
- **Modify:** `services/certs/generate.py` (add `AND u.suspended_at IS NULL` to ELIGIBLE_SQL and ELIGIBLE_PER_SESSION_SQL)
- **Modify:** `pages/functions/api/me/[token].js` (return `suspended` flag)
- **Modify:** `pages/dashboard.html` (suspension banner)
- **Modify:** `pages/dashboard.js` (show suspension banner when `suspended: true`)

---

## 3. Dashboard Email Delivery Status

### Problem

Users who never receive their cert email have no way to know it bounced. They see the cert card on the dashboard but get no email. This generates the most common support question: "I got the cert but never received the email."

### Design

**Data source:** Join `certs` against `email_outbox` on idempotency key. The cert email uses the raw cert ULID as its idempotency key (set in `generate.py` line 1042). Query per cert:

```sql
SELECT o.state AS email_state, o.last_error
  FROM email_outbox o
 WHERE o.idempotency_key = ?1
 ORDER BY o.created_at DESC LIMIT 1
```

In the batch case (me/[token] returns multiple certs), use a single query with `WHERE o.idempotency_key IN (...)` over all cert IDs to avoid N+1.

**`GET /api/me/{token}` change:** For each cert in the response, attach `email_status` (one of: `sent`, `bounced`, `queued`, `sending`, `null`) and `email_error` (the `last_error` value, only when bounced). This is a single additional query per cert batch (not per cert — batch with `IN (...)`).

**Dashboard UI change:** Each cert card already shows a state pill (Delivered, Signed, Pending, Revoked). Add a second pill for email status:
- `sent` → green "Emailed" (small, unobtrusive)
- `bounced` → red "Email bounced" + "Retry" link
- `queued`/`sending` → amber "Email sending..."
- `null` → nothing (cert pending, no email yet)

**Retry endpoint:** `POST /api/me/{token}/cert-resend/{cert_id}`

- CSRF gate: `isSameOrigin(request, env)` (token in URL)
- Rate limit: 2/hour per user (via `cert_resend:<user_id>` key)
- Only works when the most recent email for this cert is in `bounced` or `failed` state
- Inserts a new `email_outbox` row with `idempotency_key = 'resend:<cert_id>:<timestamp>'` (unique per retry, distinct from the original cert ULID key)
- Returns `{ ok: true, message: "Cert email re-queued" }` or `{ error: "not_eligible" }` (400) if the email isn't bounced/failed

**Why not reuse admin resend?** The admin endpoint (`/api/admin/cert/{token}/resend`) is bearer-gated and has no user-identity scoping. The user endpoint must verify cert ownership and is CSRF-gated.

### Files

- **Create:** `pages/functions/api/me/[token]/cert-resend/[cert_id].js`
- **Modify:** `pages/functions/api/me/[token].js` (add email_status to cert response)
- **Modify:** `pages/dashboard.html` (email status pill + retry button)
- **Modify:** `pages/dashboard.js` (render email status, retry click handler)

---

## 4. Secret Rotation Reminder Workflow

### Problem

The project has 7+ secrets (ADMIN_TOKEN, OB_SIGNING_KEY, RESEND_API_KEY, RESEND_WEBHOOK_SECRET, PDF_SIGNING_KEY_PASSWORD, CLOUDFLARE_API_TOKEN, WATCHDOG_SECRET). CLAUDE.md documents rotation dates, but there's no automated reminder. A forgotten rotation is a silent security gap.

### Design

**Rotation log file:** `secrets_rotation_log.json` — committed to the repo. Contains secret names and last-rotated ISO dates. Never contains secret values.

```json
{
  "secrets": [
    { "name": "ADMIN_TOKEN", "rotated_at": "2026-04-22", "max_age_days": 90 },
    { "name": "CLOUDFLARE_API_TOKEN", "rotated_at": "2026-04-16", "max_age_days": 90 },
    { "name": "PDF_SIGNING_KEY_PASSWORD", "rotated_at": "2026-04-15", "max_age_days": 365 },
    { "name": "WATCHDOG_SECRET", "rotated_at": "2026-04-15", "max_age_days": 90 },
    { "name": "OB_SIGNING_KEY", "rotated_at": "2026-04-24", "max_age_days": 365 },
    { "name": "RESEND_API_KEY", "rotated_at": "2026-01-01", "max_age_days": 180 },
    { "name": "RESEND_WEBHOOK_SECRET", "rotated_at": "2026-04-24", "max_age_days": 180 }
  ]
}
```

**Workflow:** `.github/workflows/secret-rotation.yml`

- Schedule: `cron: "0 10 1 * *"` (monthly, 1st of each month, 10:00 UTC)
- Also: `workflow_dispatch` for manual runs
- Steps:
  1. Checkout repo
  2. Read `secrets_rotation_log.json`
  3. For each secret, compute `days_since_rotation = today - rotated_at`
  4. If `days_since_rotation > max_age_days`, add to overdue list
  5. If overdue list is non-empty, create a GitHub issue titled `[Security] Secret rotation overdue — <count> secret(s)` with body listing each overdue secret, its age, and the RUNBOOK rotation procedure reference
  6. Issue is labeled `ops`, `security`
  7. If no secrets are overdue, workflow exits cleanly (no issue created)

**Deduplication:** Before creating an issue, check if an open issue with label `secret-rotation-overdue` already exists. If so, add a comment instead of creating a duplicate.

**Rotation procedure:** When an operator rotates a secret, they update `secrets_rotation_log.json` with the new date and commit. This is the only manual step.

### Files

- **Create:** `.github/workflows/secret-rotation.yml`
- **Create:** `secrets_rotation_log.json`

---

## 5. RUNBOOK On-Call Response SLA

### Problem

The self-healing watchdog (added 2026-04-24) auto-escalates by creating GitHub issues, but there's no documented response expectation. If auto-heal fails and an issue sits for days, no one knows they're on the clock.

### Design

New section in `docs/RUNBOOK.md` after the existing "Smoke-test after deploy" section:

**"## Incident Response"**

**Severity levels:**

| Level | Trigger | Response target | Examples |
|-------|---------|----------------|----------|
| P1 — System down | All heartbeats stale, audit chain broken, cert generation failed for >12h | 4 hours | Poller + purge + email-sender all stale; chain fork detected |
| P2 — Degraded | Single source stale after auto-heal, email delivery rate <80%, >100 queued emails >30 min old | 24 hours | Poller stale (no attendance being credited), email backlog growing |
| P3 — Cosmetic | Schema drift detected, non-blocking ops-stats warnings, cert nudge timing off | 1 week | Schema drift alert (no data loss, just DDL mismatch) |

**Escalation path:**

1. Watchdog detects stale source → runs `self-heal.sh` automatically
2. If self-heal fails → watchdog creates GitHub issue with `auto-heal-escalation` label + diagnostic bundle
3. Operator receives GitHub notification → triages per severity table above
4. If issue is P1 and no response within 4h → operator should check Discord alert webhook (if configured)
5. Manual intervention options: `gh workflow run heal.yml -f sources="<source>"` or direct `wrangler` commands per the existing RUNBOOK sections

**Post-incident:**

After resolving any P1 or P2 incident, append a short entry to the RUNBOOK's new "## Past Incidents" section:

```
### YYYY-MM-DD — <one-line summary>
- **Trigger:** What watchdog detected
- **Root cause:** What actually went wrong
- **Resolution:** What fixed it
- **Follow-up:** Any preventive action taken
```

This section starts empty. It accumulates over time as a lightweight incident log.

### Files

- **Modify:** `docs/RUNBOOK.md` (add "Incident Response" and "Past Incidents" sections)

---

## Out of scope

These were considered and intentionally deferred:

- **Credly integration** — depends on Credly API key + account setup; premature without confirmed partnership
- **SMS fallback** — no phone number field exists; requires schema + registration flow changes
- **Load testing workflow** — valuable but needs a staging environment to avoid polluting prod D1
- **Email open/click tracking** — privacy trade-off; SC-CPE's audience (security professionals) may react negatively to tracking pixels
- **Bot score escalation from Turnstile** — Turnstile response already blocks bots; score-based escalation is marginal improvement
- **Anomaly detection** — ML-based detection is over-engineered for current scale (~200 users/day)
- **Audit log encryption at rest** — D1 physical security is Cloudflare's responsibility; app-layer encryption adds complexity without meaningful threat reduction at this scale
