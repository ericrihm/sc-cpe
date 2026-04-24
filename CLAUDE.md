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
    ob/               Open Badges v3 (credential export, JWKS, signing)
    badge/[token].js  SVG badge endpoint
    leaderboard.js    public leaderboard API
  _lib.js             shared helpers (audit, isAdmin, rateLimit, etc.)
  _heartbeat.js       staleness predicate shared with admin endpoint
  _middleware.js      security headers (CSP, HSTS, COOP, ...)
  admin.html          operator dashboard (heartbeats, stats, chain)
  dashboard.html      user dashboard (attendance, certs, feedback)
  badge.html          public shareable badge page
  leaderboard.html    opt-in community leaderboard
  *.js / *.css        extracted from inline <script>/<style> (CSP hardening)
workers/
  poller/             per-minute livestream chat poller (ET 08-11 weekdays)
  purge/              daily R2 chat purge + security/weekly/monthly digest
  email-sender/       drains email_outbox via Resend
services/certs/       Python PDF issuer (PAdES-T signed)
db/
  schema.sql          authoritative schema (keep in sync with migrations)
  migrations/         append-only numbered migrations
scripts/              smoke, schema check, audit verifier, tests
  backup_d1.sh        weekly D1 export
  get_oauth_token.mjs YouTube OAuth token setup helper
  rescan_chat.py      chat replay rescan for missed attendance (needs chat_downloader)
  self-heal.sh        automated remediation playbook (called by watchdog)
  claude-heal-prompt.md  per-source diagnostic playbooks for Claude Code triage
.github/workflows/    CI: ci.yml (tests+gitleaks), smoke.yml (hourly),
                      watchdog.yml (15min + self-heal + escalation),
                      heal.yml (manual self-heal dispatch),
                      monthly-certs.yml (bundled sweep),
                      cert-sign-pending.yml (2h pending-cert pickup),
                      schema-drift.yml (weekly D1 vs schema.sql),
                      backup.yml (weekly D1 backup),
                      rescan-chat.yml (daily chat replay rescan)
.githooks/pre-push    runs scripts/test.sh before push
docs/DESIGN.md        architecture decisions
docs/PITCH.md         Simply Cyber team pitch
CONTRIBUTING.md       community contribution guidelines
LICENSE               MIT
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

7. **`cert_kind` is app-enforced domain** (`bundled`|`per_session`). SQLite
   partial unique indexes gate duplicates per-scope: bundled one per
   (user, period), per_session one per (user, stream). Reissue flow creates
   a new pending row with `supersedes_cert_id` set; Python cron flips the
   old row to `state='regenerated'` on successful delivery and logs action
   `cert_regenerated`. Never UPDATE a generated cert in place — always
   supersede.

8. **CSP `script-src 'self'` — no inline JS.** All inline `<script>` blocks
   have been extracted to external `.js` files. Any new page JS must go in
   an external file. `style-src 'unsafe-inline'` is still allowed (inline
   `style=` attributes throughout HTML).

9. **YouTube poller supports OAuth (preferred) with API-key fallback.**
   OAuth secrets: `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`,
   `YOUTUBE_OAUTH_REFRESH_TOKEN`. Google Cloud project: `sc-yt-493317`.
   Quota circuit breaker trips for 15 min on `quotaExceeded`, stored in
   `kv` as `circuit.youtube_quota`.

10. **Monthly digest runs on UTC day 1 via purge worker.** Added to
    `EXPECTED_CADENCE_S` as `monthly_digest: 2678400`.

11. **`show_on_leaderboard`** column on `users` (migration 004). Opt-in
    boolean; `email_prefs` JSON column also stores `renewal_tracker` object.

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

Pages + Workers auto-deploy on every merge to `main` via
`.github/workflows/deploy-prod.yml` (tests → D1 migrations → Pages →
Workers matrix → post-deploy smoke). D1 migrations in `db/migrations/`
are applied automatically — the pipeline tracks applied files in an
`_applied_migrations` table and only runs new ones. No manual
`wrangler d1 execute` needed. `main` is branch-protected: PRs required, status
checks `Node test suite` + `Secret scan (gitleaks)` must be green,
no force-push, no deletions. `enforce_admins: false` is deliberate —
admin (owner) can break-glass push if CI itself is broken; otherwise
use the PR flow.

Normal flow for an edit:

```
git checkout -b kind/topic
# ...edits...
git commit -m "kind(scope): message"
git push -u origin kind/topic
gh pr create --fill
gh pr merge --auto --squash
```

Auto-merge is enabled repo-wide; `gh pr merge --auto` lands the PR the
moment required checks go green and triggers `deploy-prod`.

Emergency break-glass:
- If CI is broken and blocking merge: toggle off the required-checks
  rule in Settings → Branches, ship, re-engage.
- If it's a one-off "ship now" case: direct `git push origin main` works
  because `enforce_admins: false` — the push trigger still fires
  `deploy-prod`, which re-runs tests as its first job so we don't ship
  broken code silently.

The manual fallback still works if `deploy-prod.yml` is itself broken:

```
cd pages && wrangler pages deploy .
cd workers/purge && wrangler deploy
cd workers/poller && wrangler deploy
cd workers/email-sender && wrangler deploy
```

Python cron (`services/certs/generate.py`) runs via GitHub Actions, not
wrangler. Two modes:
- default: monthly bundled sweep over `ELIGIBLE_SQL` + per_session fan-out
  for users with `email_prefs.cert_style in ('per_session','both')`.
- `--pending-only` / `PENDING_ONLY=1`: drains `certs WHERE state='pending'`
  — fills rows inserted by the per-session endpoint or admin reissue.
  Never use the bundled path to fulfil these; it will INSERT a duplicate.

Note: `deploy-prod.yml` uses `--commit-message=$SHA` instead of
`--commit-dirty=true` to avoid CF Pages UTF-8 rejection on non-ASCII
commit messages.

YouTube OAuth token setup (one-time):
```
node scripts/get_oauth_token.mjs <client_secret.json>
```

The purge worker exposes a bearer-gated on-demand trigger:
`POST https://sc-cpe-purge.ericrihm.workers.dev/?only=<block>` where
`<block>` ∈ `purge|security_alerts|weekly_digest|cert_nudge|all`. Use it
to verify cron paths without waiting for 09:00 UTC. `workers_dev=true` in
`workers/purge/wrangler.toml` is deliberate — it's how the fetch handler
is reachable.

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

## Known gaps (as of 2026-04-17)

- **Out-of-band leaked secrets** (chat/screenshots, NOT git history) —
  verified clean against full git history with gitleaks 8.21.2 +
  `git log -S` regex on 2026-04-15. Rotation status:
    - `PDF_SIGNING_KEY_PASSWORD` — **rotated 2026-04-15**. Re-wrapped existing
      p12 with a new password (keypair + cert fingerprint `e85b7593…`
      unchanged, so no verify-portal trust update needed). New password at
      `~/.cloudflare/sc-cpe-pdf-signing-pw`. Verified via
      `cert-sign-pending` workflow_dispatch → `signing_material_loaded`.
    - `WATCHDOG_SECRET` — **rotated 2026-04-15**. Updated both GH Actions
      secret and CF Pages production env; Pages redeployed to pick up.
      New value at `~/.cloudflare/sc-cpe-watchdog-secret`. Verified via
      200 response from `/api/watchdog-state`.
    - CF API tokens `cfat_cjNGGSBM...`/`cfut_AxNjVmVf...` — **rotated
      2026-04-16**. Replaced by a single narrow-scope `sc-cpe-gha-api`
      token (D1 Edit only, scoped to the `sc-cpe` database). New value at
      `~/.cloudflare/signalplane.env` and GH secret `CLOUDFLARE_API_TOKEN`.
      Verified via `/user/tokens/verify` (active) and a direct D1 query
      (31 schema rows). Old tokens revoked in the CF dashboard.
    - `ADMIN_TOKEN` — **rotated 2026-04-22**. Updated GH Actions secret,
      CF Pages production env, and purge worker secret. Pages redeployed.
      New value at `~/.cloudflare/sc-cpe-admin-token`. Verified via purge
      worker `?only=link_enrichment` (200 OK).
- `signalplane.co` has DKIM (Resend) + SPF but **no DMARC record**.
  Recommend `v=DMARC1; p=none; rua=mailto:...` for observability; not a
  blocker since DKIM-aligned Resend delivers fine today.
- Weekly digest is Mon-only on UTC day boundary — may drift vs. US weekday
  expectation around DST; not an issue until it is.
- `scripts/check_schema.sh` canonicalise was broken pre-2026-04-16
  (heredoc on `python3 -` consumed stdin as the script source, so
  `sys.stdin.read()` returned `""` and every drift comparison was `"" == ""`
  — a silent pass). Fixed + schema.sql reconciled with live on 2026-04-16;
  first actual green run via workflow_dispatch.
- Deploy pipeline uses `--commit-message=$SHA` instead of
  `--commit-dirty=true` to avoid CF Pages UTF-8 rejection on non-ASCII
  commit messages.
- YouTube OAuth setup complete 2026-04-17. Google Cloud project
  `sc-yt-493317`, test user `ericrihm@gmail.com` added to OAuth consent
  screen.
- CSP `unsafe-inline` removed from `script-src` on 2026-04-17. All inline
  scripts extracted to external files. `style-src 'unsafe-inline'` retained
  — removing it requires refactoring all inline `style=` attributes.
- Leaderboard migration (004) applied to prod on 2026-04-17.
- CF Pages PR previews active — `[env.preview]` in `wrangler.toml` has
  real D1/KV/R2 bindings. Preview D1: `sc-cpe-preview`
  (`8aa974e0-e0d8-4120-b2c3-172f441b2520`), KV: `sc-cpe-rate-preview`
  (`3eecd067a6bf44eca56a8feaca4d127c`), R2: `sc-cpe-certs-preview`.
  Backup bucket: `sc-cpe-backups`. Deploy workflow:
  `.github/workflows/deploy-preview.yml`.
- Show Links Archive (migration 005) deployed 2026-04-22. Poller
  extracts URLs from host/mod chat; purge worker enriches with titles
  daily. Public page at `/links.html`, API at `/api/links`.
- Poller had zero messages scanned for Apr 15-21 streams (all flagged).
  Root cause was three stacked bugs: wrong API URL (`/liveChatMessages`
  vs `/liveChat/messages`), silent OAuth-to-API-key fallback (API key
  can't read liveChatMessages), and expired OAuth refresh token. All
  three fixed 2026-04-23 and deployed. No raw chat in R2 for those
  dates; links archive starts from first show after 2026-04-22 deploy.
- **Chat replay rescan** (`scripts/rescan_chat.py`) uses `chat_downloader`
  to pull chat replays from ended streams and retroactively credit
  attendance. Workflow: `.github/workflows/rescan-chat.yml` (daily 16:00
  UTC + manual). **Blocker:** Simply Cyber channel currently has chat
  replay disabled — all 6 flagged streams return "Live chat replay is
  not available." Gerald must enable it in YouTube Studio → Settings →
  Community → Defaults → Live chat replay for this to work.
- **Admin attendance window check was sign-inverted** — fixed 2026-04-22.
  `admin/attendance.js:81` had `startMs + grace` (rejected pre-stream
  evidence, accepted post-stream). Corrected to `startMs - grace` to
  match the poller's formula.
- **Audit-proofness gaps documented 2026-04-22** (no code changes needed):
    - Appeal-granted attendance rows carry synthetic `first_msg_id` and
      empty `first_msg_sha256` — no YouTube chat evidence. Distinguishable
      via `source='appeal_granted'` in the attendance table and audit log.
    - Admin no-evidence grants (`source='admin_manual'` without
      `chat_evidence`) are self-attesting — the `reason` free-text in
      the audit log is the sole justification.
    - The public verify portal (`/api/verify/[token]`) does not surface
      per-session credit source (poll vs. appeal vs. admin). An auditor
      who cares about this needs D1 read access.
    - `yt_display_name_seen` is not captured in the `user_verified`
      audit log entry — if the user deletes their account, the display
      name at binding time is lost.
    - PAdES-LTA re-sign ceremony needed before the signing cert's 10-year
      expiry. See `docs/LTV.md` for the full analysis.
- **Hardcoded SITE_BASE removed** — fixed 2026-04-22 (PR #55). All 5 API
  endpoint files (`register`, `recover`, `rotate`, `resend-code`,
  `admin/cert/resend`) now derive the origin from `request.url` instead of
  hardcoding `sc-cpe-web.pages.dev`. URLs in emails will automatically
  work when `cpe.simplycyber.io` custom domain is added.
- **OAuth degradation alerting** — added 2026-04-22 (PR #56). Poller
  heartbeat now includes `auth_method` (`oauth`/`api_key`/`none`) in
  `detail_json`. `/api/health` surfaces detail per source.
  `/api/admin/ops-stats` warns when poller falls back to API key.
- **Security audit fixes** — 2026-04-22. Migrations 006 (cert reissue
  index) + 007 (badge_token). Key changes:
    - `badge_token` column on `users` — badge/share URLs use this instead
      of `dashboard_token`, preventing credential leak in shared links.
      Badge endpoint looks up by `badge_token`. Rotate regenerates both.
    - Cert reissue unique index: partial unique indexes now exclude
      `state = 'regenerated'`; reissue endpoint sets old cert to
      `regenerated` before INSERT to avoid constraint violation.
    - XSS: admin.js `innerHTML` calls now use `escapeHtml()`;
      generate.py uses `html.escape()` for recipient_name;
      cert resend email escapes `sessionsCount`.
    - enrichShowLinks always sets `enriched_at` (even on fetch failure)
      to prevent infinite retry loop.
    - `cert_nudge` added to `EXPECTED_CADENCE_S` in both `_heartbeat.js`
      and purge worker mirror.
    - `ip_hash` moved from `after` to `opts` param in 4 audit callers
      (download, verify, register ×2) so it lands in the `ip_hash` column.
    - generate.py email claim sets `sent_at` so the email-sender's
      stuck-row rescue can reclaim it.
    - Security alert cursor advances to `nowIso` on stale-only digests.
    - resend-code "within 7 days" corrected to "before it expires".
    - CRL endpoint sets `Cross-Origin-Resource-Policy: cross-origin`.
    - admin.js reissue click listener moved to one-time registration.
- **Credential portability** — added 2026-04-24. OBv3 credential export
  (`/api/ob/credential/[token].json`), Ed25519 signed with DataIntegrityProof
  (`eddsa-rdfc-2022`), JWKS at `/api/ob/jwks`. LinkedIn "Add to Profile"
  deep-link + CPE submission guide page (`cpe-guide.html`) with CompTIA/
  ISC2/ISACA tabs and copy-to-clipboard. Requires `OB_SIGNING_KEY` Pages
  secret (see RUNBOOK "Open Badge Signing Key"). HSTS preload directive added.
- **Self-healing watchdog** — added 2026-04-24. `watchdog.yml` now runs
  `scripts/self-heal.sh` after detecting stale sources. Playbook: purge-family
  sources re-triggered via on-demand HTTP endpoint; email-sender/poller wait
  for transient recovery. Safety: 2h cooldown per source, 3 heals/day max
  (tracked in watchdog KV). On heal failure: creates GitHub issue with
  diagnostic bundle + Claude Code triage prompt (`auto-heal-escalation` label).
  Manual dispatch: `gh workflow run heal.yml -f sources="purge email_sender"`.
  Per-source playbooks in `scripts/claude-heal-prompt.md`.
- **Watchdog-state regex fix** — 2026-04-24. Source name regex changed from
  `/^[a-z0-9_-]{1,32}$/` to `/^[a-z0-9_:.-]{1,64}$/` to support `warn:`
  prefix and `heal:` tracking keys. The old regex silently rejected ops-stats
  warning dedup writes.
- **Resend bounce/complaint webhook** — added 2026-04-24. New endpoint
  `/api/email-webhook` processes Resend Svix-signed webhook events
  (`email.bounced`, `email.complained`). Marks outbox rows `bounced`,
  inserts into `email_suppression` table (migration 012). Email-sender
  checks suppression before sending — suppressed rows get `bounced`
  immediately with `last_error = 'suppressed:hard_bounce'`. Requires
  `RESEND_WEBHOOK_SECRET` Pages secret (passes through if unset during
  initial setup). Configure webhook URL in Resend dashboard.
- **Email unsubscribe** — added 2026-04-24. `/api/me/{token}/unsubscribe`
  endpoint (GET = confirmation page, POST = one-click per RFC 8058).
  Categories: `monthly_digest`, `cert_nudge`, `renewal_nudge`,
  `streak_milestone`. `email_prefs.unsubscribed` array stores opt-outs.
  All engagement emails include `List-Unsubscribe` + `List-Unsubscribe-Post`
  headers and footer unsubscribe link. Prefs endpoint accepts
  `unsubscribed[]` for dashboard re-subscribe.
- **Streak milestone emails** — added 2026-04-24. Poller queues celebration
  emails at 5, 10, 25, 50, 100-day streaks. `updateStreak()` now returns
  the new streak value. Idempotency key `streak:<userId>:<milestone>`
  ensures each milestone emailed once per user ever.
- **OpenGraph/Twitter Card tags** — added 2026-04-24. Verify, leaderboard,
  and CPE guide pages now have OG + Twitter Card meta tags for rich social
  previews when shared.
- **Schema drift daily** — changed 2026-04-24. `schema-drift.yml` cron
  changed from weekly (Mon 10:00 UTC) to daily (10:00 UTC), closing the
  6-day blind spot after mid-week migrations.

## Where to look for more context

- `docs/RUNBOOK.md` — operator-facing ops procedures
- `docs/LTV.md` — legal/compliance reasoning (GDPR Art. 17(3)(e) carve-out)
- `docs/DESIGN.md` — architecture decisions
- `docs/PITCH.md` — Simply Cyber team pitch
- `outputs/handoffs/` — session-end briefs; the most recent one is always
  the fastest way to understand "where we are right now"
