# SC-CPE

Automated CPE (Continuing Professional Education) certificates for attendees
of the [Simply Cyber Daily Threat Briefing](https://www.youtube.com/@simplycyber)
YouTube livestream.

**How it works:** You register, get a per-user code, post it in the live chat
during the briefing, and a monthly cron issues you a cryptographically signed
PDF cert listing every session you attended. A third-party auditor can verify
the cert years later without talking to us.

## Status

Hardened and in production on Cloudflare (Pages + Workers + D1 + R2). Smoke
suite green, audit chain intact, heartbeat alarm + hourly synthetic canary
running.

## Stack

- **Frontend + API:** Cloudflare Pages Functions (`pages/`)
- **Workers:** poller (livestream chat), purge (daily R2 + digests),
  email-sender (Resend outbox drainer)
- **DB:** Cloudflare D1 (SQLite). Schema: `db/schema.sql`
- **Storage:** R2 for raw chat + signed PDFs
- **Email:** Resend (`certs@signalplane.co`)
- **Cert signing:** Python (PAdES-T) in `services/certs/`

## Key endpoints

| Path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/register` | none (Turnstile) | Sign-up |
| `GET /api/me/{token}` | dashboard-token | User view |
| `POST /api/me/{token}/cert-feedback` | dashboard-token + CSRF | Report typo/wrong |
| `POST /api/me/{token}/prefs` | dashboard-token + CSRF | Set `cert_style` (bundled/per_session/both), monthly nudge opt-out |
| `POST /api/me/{token}/cert-per-session/{stream_id}` | dashboard-token + CSRF | Request single-session cert (idempotent) |
| `GET /api/health` | none | External watchdog poll |
| `GET /api/admin/heartbeat-status` | bearer | Per-source staleness |
| `GET /api/admin/audit-chain-verify` | bearer | Full chain walk |
| `GET /api/admin/ops-stats` | bearer | Dashboard counts |
| `GET /api/admin/cert-feedback` | bearer | Non-ok cert-feedback inbox |
| `POST /api/admin/cert/{id}/reissue` | bearer | Queue regenerated cert (supersedes chain) |
| `POST /api/admin/canary-beat` | bearer | Hourly smoke heartbeat |

Pages:

- `/dashboard.html?t=TOKEN` — user dashboard (attendance, certs, feedback)
- `/admin.html` — operator dashboard (paste ADMIN_TOKEN in-page)
- `/verify.html?t=PUBLIC_TOKEN` — public cert verification

## Developing

Prerequisites: Node 20+, Python 3.11+, `wrangler` logged in.

```bash
# Install git hooks (runs test suite pre-push)
scripts/install_hooks.sh

# Run the pure-logic tests
bash scripts/test.sh

# Check live D1 schema vs. repo schema
scripts/check_schema.sh

# Smoke the deployed origin
ADMIN_TOKEN=... ORIGIN=https://cpe.simplycyber.io scripts/smoke_hardening.sh

# Verify full audit chain
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... D1_DATABASE_ID=... \
  python scripts/verify_audit_chain.py
```

## Deploying

Every Pages deploy is currently manual (GitHub → Pages wiring is a TODO):

```bash
cd pages && wrangler pages deploy .
cd workers/purge && wrangler deploy
cd workers/poller && wrangler deploy
cd workers/email-sender && wrangler deploy
```

After any deploy, run the smoke suite. The hourly GitHub Action (`smoke.yml`)
does this automatically and pings Discord on failure.

## Observability

- **Heartbeats** (`heartbeats` table): `poller`, `purge`, `security_alerts`,
  `email_sender`, `canary`, `weekly_digest`. Expected cadences live in
  `pages/functions/_heartbeat.js`.
- **Watchdog** (`.github/workflows/watchdog.yml`): polls `/api/health` every
  15 min, posts Discord alerts on stale transitions (with dedup).
- **Daily digest**: purge worker 09:00 UTC, security events + stale heartbeats.
- **Weekly digest**: purge worker, Mondays 09:00 UTC, registration/cert/appeal
  rollup.
- **Monthly cert nudge**: purge worker on UTC day 8, one reminder per prior-
  month bundled cert without feedback (respects `email_prefs.monthly_cert`).
- **Hourly canary** (`.github/workflows/smoke.yml`): runs smoke suite against
  prod, writes `canary` heartbeat on success.
- **Pending-cert pickup** (`.github/workflows/cert-sign-pending.yml`): every
  2h, signs rows in `state='pending'` (on-demand per-session + admin reissues).
- **Admin on-demand trigger**: `POST https://sc-cpe-purge.ericrihm.workers.dev/?only=<block>`
  (bearer-gated). `only` ∈ `purge|security_alerts|weekly_digest|cert_nudge|all`.

## Repo layout

See [`CLAUDE.md`](./CLAUDE.md) for working notes and invariants.
See [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) for operator procedures.

## License

Internal. All rights reserved. Cert artefacts are retained under
GDPR Art. 17(3)(e) as evidentiary records (see `pages/functions/api/me/[token]/delete.js`
for the carve-out reasoning).
