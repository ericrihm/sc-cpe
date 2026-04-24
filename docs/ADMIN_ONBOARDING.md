# Admin Onboarding Guide

## How admin auth works

Admins authenticate via magic link email. The flow:

1. Admin visits `/admin.html` and enters their email
2. System sends a time-limited login link (15 min expiry)
3. Clicking the link sets a session cookie
4. All subsequent API calls use the cookie (or bearer token fallback)

Admin emails are configured in the `ADMIN_EMAILS` environment variable
on Cloudflare Pages (comma-separated list).

## Adding a new admin

1. Go to Cloudflare Pages > sc-cpe-web > Settings > Environment variables
2. Edit `ADMIN_EMAILS` (Production) to add the new email
3. Trigger a redeploy (merge any PR, or manual `wrangler pages deploy`)
4. The new admin can now log in at `/admin.html`

## Dashboard sections

| Section | What it shows |
|---------|---------------|
| **Overview** | Users, certs, attendance, email queue stats (last 24h) |
| **Analytics** | Growth, engagement, cert, and system metrics with date range |
| **War Room** | Rate limit trips and auth failures (24h sparklines) |
| **Kill switches** | Emergency toggles to disable public endpoints |
| **Manual triggers** | On-demand execution of purge worker cron blocks |
| **Email Suppression** | Bounced/complained addresses blocked from sending |
| **Heartbeats** | Worker health — each cron writes a heartbeat row |
| **Audit chain** | Hash-chain integrity verification |
| **Streams** | Recent livestream sessions with attendance counts |
| **Users** | Search by name, email, channel ID, or user ID |
| **Appeals** | Attendance dispute queue with grant/deny actions |
| **Cert feedback** | User-reported typos/errors with re-issue button |

## Common admin tasks

**Search a user**: Type 2+ characters in the Users search box. Results
show name, email, state, and counts. Click "Details" for full metadata.

**Suspend/unsuspend**: Find the user, click Suspend/Unsuspend. Requires
a reason (logged in audit trail). Suspended users cannot earn attendance
or receive certs.

**Revoke a certificate**: Use the Revoke Certificate form with the cert's
64-char public token, or click Revoke on a cert row in user search results.

**Grant manual attendance**: Click "Grant attendance" on a user row to
pre-fill the user ID, then fill in stream ID and reason. The stream must
exist in the database.

**Resolve an appeal**: Load appeals (Open tab), review evidence, click
Grant or Deny. Grant auto-inserts an attendance row.

**Re-issue a cert**: From cert feedback or user cert list, click Re-issue.
Creates a new pending cert that supersedes the old one.

## Emergency procedures

**Kill switches**: Toggle any endpoint to return 503. Use when an
endpoint is being abused or a downstream dependency is failing. The
toggle is instant — no redeploy needed.

**Manual cron triggers**: Click "Run" on any block to execute it
immediately via the purge worker. Useful for testing or forcing a
digest/purge outside its normal schedule.

**Self-healing watchdog**: Runs every 15 minutes via GitHub Actions.
If a worker goes stale, it auto-triggers the purge worker's on-demand
endpoint. Failures create GitHub issues with the `auto-heal-escalation`
label. Manual dispatch: `gh workflow run heal.yml -f sources="purge"`.

## Where to find logs and alerts

- **GitHub Actions**: CI runs, watchdog alerts, monthly cert sweep
- **Watchdog issues**: Auto-created with `auto-heal-escalation` label
- **Secret rotation**: Monthly check via `secret-rotation.yml` workflow
- **Schema drift**: Daily check via `schema-drift.yml` workflow
- **Ops-stats warnings**: Shown at the top of the admin dashboard

## Escalation path

| Severity | Response time | Examples |
|----------|--------------|---------|
| P1 | 4 hours | Audit chain broken, all crons stale |
| P2 | 24 hours | Single cron stale, email delivery failing |
| P3 | 1 week | Schema drift, non-critical warning |
