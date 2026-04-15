# CLAUDE.md — working notes for AI assistants in this repo

## What this system is

SC-CPE auto-issues CPE certificates to people who attend the Simply Cyber
Daily Threat Briefing YouTube livestream. Users post a per-user code in chat;
the poller sees the code, credits attendance, and the monthly cron issues a
signed PDF cert. Every state change writes a hash-chained audit row so the
cert is independently verifiable by a third-party auditor years later.

## Shape of the codebase

```
pages/                Cloudflare Pages Functions — the public web surface
  functions/api/      JSON API
    admin/            bearer-token (ADMIN_TOKEN) gated endpoints
    me/[token]/       dashboard-token gated endpoints (CSRF-sensitive)
  _lib.js             shared helpers (audit, isAdmin, rateLimit, etc.)
  _heartbeat.js       staleness predicate shared with admin endpoint
  _middleware.js      security headers (CSP, HSTS, COOP, ...)
  admin.html          operator dashboard (heartbeats, stats, chain)
  dashboard.html      user dashboard (attendance, certs, feedback)
workers/
  poller/             per-minute livestream chat poller (ET 08-11 weekdays)
  purge/              daily R2 chat purge + security digest + weekly digest
  email-sender/       drains email_outbox via Resend
services/certs/       Python PDF issuer (PAdES-T signed)
db/
  schema.sql          authoritative schema (keep in sync with migrations)
  migrations/         append-only numbered migrations
scripts/              smoke, schema check, audit verifier, tests
.github/workflows/    CI: ci.yml (tests+gitleaks), smoke.yml (hourly), watchdog.yml
.githooks/pre-push    runs scripts/test.sh before push
```

## Invariants that MUST hold

1. **Audit log is append-only, hash-chained.** Never UPDATE or DELETE
   `audit_log` rows. Every writer must compute `prev_hash` as
   `sha256(canonicalAuditRow(tip))`. The canonical form is duplicated across
   `pages/functions/_lib.js`, `workers/*/src/index.js`, and
   `scripts/verify_audit_chain.py` — keep them byte-identical.
   `scripts/test_chain_parity.mjs` guards this.

2. **`UNIQUE INDEX audit_prev_hash_unique` must exist.** It's what serialises
   concurrent audit writers. `/api/admin/audit-chain-verify` refuses to
   return `ok:true` without it.

3. **Admin endpoints use bearer tokens, NOT CSRF gates.** Browsers don't
   auto-send `Authorization` headers cross-origin, so admin endpoints are
   CSRF-immune by construction. `/api/me/[token]/*` endpoints ARE
   CSRF-sensitive (token sits in URL) and must call `isSameOrigin()`.

4. **Token expiry is 72h.** `register.js` and `resend-code.js` both enforce.
   Shortening further is fine; extending it widens the race-attack window.

5. **Email sender cursor advances only on successful Resend POST.** The
   security-alert digest + weekly digest follow the same rule — a failed
   send must leave the cursor so the next run retries that window.

6. **`heartbeats` table is the single source of truth for "is the system
   healthy."** Every cron writes one. `/api/admin/heartbeat-status` and the
   purge worker's stale-heartbeat digest both read it. If you add a new
   cron, add its expected cadence to `pages/functions/_heartbeat.js`
   AND the mirrored copy in `workers/purge/src/index.js`.

## Testing

```
bash scripts/test.sh            # node --test suite; runs pre-push
scripts/smoke_hardening.sh      # read-only probes against deployed origin
scripts/check_schema.sh         # diff live D1 schema vs. schema.sql
scripts/verify_audit_chain.py   # full chain integrity check (via D1 HTTP API)
```

All new pure-logic code should get a `node --test` file wired into
`scripts/test.sh`. Cross-language canonical-form changes need
`scripts/test_chain_parity.mjs` to still pass.

## Deploying

Pages auto-deploy from GitHub is NOT currently wired. Every Pages deploy is
manual:

```
cd pages && wrangler pages deploy .
cd workers/purge && wrangler deploy
cd workers/poller && wrangler deploy
cd workers/email-sender && wrangler deploy
```

After deploy, always run smoke:

```
ADMIN_TOKEN="$(tr -d '\n' < ~/.cloudflare/sc-cpe-admin-token)" \
  ORIGIN="https://sc-cpe-web.pages.dev" scripts/smoke_hardening.sh
```

## Conventions for edits

- **No new comments unless WHY is non-obvious.** What the code does is
  readable; leave notes only for hidden constraints, workarounds, or
  security-relevant gotchas.
- **No backwards-compat shims.** If you remove a field, remove it — don't
  leave a `_removed` stub.
- **Prefer editing to adding files.** This repo is small; don't create a new
  `utils.js` when `_lib.js` is right there.
- **Input validation at boundaries only.** Trust internal calls; validate
  user input in the endpoint that receives it.

## Known gaps (as of 2026-04-15)

- Pages auto-deploy from GitHub is unwired (dashboard action, not code).
- 4 secrets leaked to chat in prior session still need rotation:
  CF API tokens `cfat_cjNGGSBM...`/`cfut_AxNjVmVf...`, `WATCHDOG_SECRET`,
  `PDF_SIGNING_KEY_PASSWORD`. Rotate before any serious traffic.
- Weekly digest is Mon-only on UTC day boundary — may drift vs. US weekday
  expectation around DST; not an issue until it is.

## Where to look for more context

- `docs/RUNBOOK.md` — operator-facing ops procedures
- `docs/LTV.md` — legal/compliance reasoning (GDPR Art. 17(3)(e) carve-out)
- `outputs/handoffs/` — session-end briefs; the most recent one is always
  the fastest way to understand "where we are right now"
