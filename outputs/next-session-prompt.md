# Next Session Prompt — Verify & Extend

Paste this into a new Claude Code session:

---

Previous session merged PRs #56 (OAuth alerting) and #67 (ops-polish), cleaned up 51 stale branches, and added 26 new tests covering `_lib.js` security functions and the email-sender worker (PR #68). Deploy-prod was stuck in "pending" at session end — GitHub Actions queue delay.

Read CLAUDE.md first. Work on `main`. Commit after each item. Run `bash scripts/test.sh` after each commit.

## 1. Verify production is healthy

Check deploy-prod landed and smoke tests are green:

```bash
gh run list --workflow deploy-prod.yml --limit 3
gh run list --workflow smoke.yml --limit 3
```

If deploy-prod is still stuck:
1. Cancel: `gh run cancel <id>`
2. Re-trigger: `gh workflow run deploy-prod.yml --ref main`
3. If it stays stuck, bypass via manual deploy:
   ```bash
   cd pages && wrangler pages deploy .
   cd ../workers/purge && wrangler deploy
   cd ../poller && wrangler deploy
   cd ../email-sender && wrangler deploy
   ```

Run smoke tests manually:
```bash
ADMIN_TOKEN="$(tr -d '\n' < ~/.cloudflare/sc-cpe-admin-token)" \
  ORIGIN="https://sc-cpe-web.pages.dev" bash scripts/smoke_hardening.sh
```

All 42 probes should pass. If the 3 new probes (streams/suspend/email-suppression) still fail after deploy confirms, it's a real auth bug — read the endpoint source and fix.

## 2. Merge PR #68 (test coverage)

PR #68 adds security function + email-sender tests (370 total). Auto-merge is set; if it hasn't landed:

```bash
gh pr view 68 --json state,statusCheckRollup
gh pr merge 68 --squash   # if checks passed
```

## 3. Merge dependabot PRs

PRs #34-38 (Python deps) have auto-merge set. Check if any are still open:

```bash
gh pr list --state open --json number,title
```

For any still open, check CI status and merge. WeasyPrint 63→68 is a major bump — after merge, verify `services/certs/generate.py` still works by running the cert-sign-pending workflow:

```bash
gh workflow run cert-sign-pending.yml
```

## 4. Purge worker scheduled task tests

The purge worker has 7 untested scheduled tasks (26% coverage). Create `workers/purge/src/scheduled-tasks.test.mjs`:

**Security alerts** — 3 tests:
- No events in window → no email queued
- Events present → email queued with correct subject/recipients
- Cursor advances only after successful queue

**Weekly digest** — 2 tests:
- No attendance data → digest still sends with zero stats
- Digest includes correct date range (previous 7 days)

**Cert nudge** — 2 tests:
- User with pending cert > 7 days → nudge queued
- User with delivered cert → no nudge

Read `workers/purge/src/index.js` first — each function (runSecurityAlerts, runWeeklyDigest, runCertNudges) follows the same pattern: query → filter → queue email → advance cursor → heartbeat.

Wire into `scripts/test.sh`. Run full suite.

## 5. Test `_lib.js` remaining functions

Extend `pages/functions/_lib-security.test.mjs` with:

**`classifyRevocation(reason)`** — 3 tests:
- Known keyword ("fraud") → mapped enum
- Unknown text → "other"
- Empty/null → "unspecified"

**`escapeHtml(str)`** — 3 tests:
- Escapes `<`, `>`, `&`, `"`, `'`
- Preserves safe text unchanged
- Handles null/undefined gracefully

**`killSwitched(env, name)`** — 2 tests:
- KV has `kill:<name>` set → true
- KV empty → false

Wire and run.

## 6. Verify ops-stats includes new poller field

After deploy lands, verify the OAuth alerting from PR #56 works:

```bash
curl -s -H "Authorization: Bearer $(tr -d '\n' < ~/.cloudflare/sc-cpe-admin-token)" \
  https://sc-cpe-web.pages.dev/api/admin/ops-stats | jq '.poller'
```

Should return `{ "auth_method": "oauth" }` (or `"api_key"` if OAuth is degraded).

---

**Order:** 1 (verify) → 2-3 (merges) → 4-5 (tests, can parallel) → 6 (final check).

**Do NOT do in this session** (save for later):
- DMARC DNS record (Cloudflare dashboard, not code)
- RESEND_API_KEY rotation (113/180 days, due ~July 2026)
- PAdES-LTA re-sign (18-month runway)
- HSTS preload (blocked on custom domain)
- Rate-limit tuning review (scheduled ~2026-05-08)
