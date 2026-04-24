# Next Session Prompt — QA & Hardening

Paste this into a new Claude Code session:

---

QA/hardening session for the `feat/ops-polish` bundle (PR #67). Goal: find bugs, edge cases, and integration gaps across all 8 shipped features before merge. Read CLAUDE.md first.

Work on `main` (or the merge result). Commit fixes as you go. Run `bash scripts/test.sh` after each fix to confirm green. Push when done.

## Phase 1: Smoke test the new probes

Run the updated smoke suite against the deployed preview (or prod):

```bash
ADMIN_TOKEN="$(tr -d '\n' < ~/.cloudflare/sc-cpe-admin-token)" \
  ORIGIN="https://sc-cpe-web.pages.dev" bash scripts/smoke_hardening.sh
```

Verify all new probes pass: `admin/streams`, `admin/analytics/*` (4 endpoints), `admin/suspend`, `admin/email-suppression`. If any fail, triage and fix the endpoint before continuing.

## Phase 2: Analytics dashboard edge cases

Test each analytics endpoint with boundary inputs:

1. **Empty database**: What happens when there are zero users, zero attendance, zero certs? Each of the 4 analytics endpoints should return valid JSON with empty arrays / zero counts — not 500.
2. **Range boundaries**: Call each with `?range=7d`, `?range=90d`, `?range=all`, `?range=invalid`, `?range=` (empty). Invalid/missing should fall back to 30d, not error.
3. **Growth time-series ordering**: Verify `GET /api/admin/analytics/growth` returns `registrations_by_period` sorted ascending by period. Check that the period labels match the range (daily for 7d/30d, weekly for 90d, monthly for all).
4. **Admin.js rendering**: Open admin.html in a browser. Click "Load" on the Analytics section with each range. Verify:
   - Stat cards render with correct labels (no `undefined` or `NaN`)
   - Time-series table has correct column headers
   - Empty states show "No data" rather than a blank or broken table
   - No console errors

## Phase 3: Streams endpoint + UI

1. **Streams with no data**: Call `GET /api/admin/streams?days=7` when no streams exist in the range. Should return `{ ok: true, streams: [] }`, not error.
2. **Days parameter validation**: Test `?days=0`, `?days=-1`, `?days=999`, `?days=abc`, no param. Should clamp to 1-365 range or default to 30.
3. **Attendance count accuracy**: For a stream with known attendance, verify the `attendance_count` subquery returns the correct number. Cross-check against `GET /api/admin/attendance`.
4. **YouTube link generation**: In admin.js, verify that the YouTube link for each stream row correctly links to `https://youtube.com/watch?v={yt_video_id}`. Streams with null `yt_video_id` should not show a broken link.
5. **Table rendering**: Open admin.html, load streams with different day ranges. Verify the "No streams found" empty state appears when appropriate.

## Phase 4: Email preferences UI

1. **Initial state**: Register a test user. Open their dashboard. Verify the email preferences card shows all 4 categories checked (subscribed by default).
2. **Toggle persistence**: Uncheck "Monthly digest", wait for the POST to complete, refresh the page. Verify the checkbox stays unchecked.
3. **Multiple toggles**: Uncheck all 4 categories, refresh. Re-check 2 of them, refresh. Verify state persists correctly each time.
4. **Race condition**: Rapidly toggle checkboxes. Verify no duplicate POST requests pile up and the final state is correct.
5. **Error handling**: What happens if the prefs POST fails (e.g., network error)? Does the checkbox revert? Is there user feedback?
6. **Interaction with unsubscribe endpoint**: If a user has unsubscribed via email footer link (setting `email_prefs.unsubscribed = ["monthly_digest"]`), does the dashboard correctly show that category unchecked?

## Phase 5: User detail expansion

1. **Field completeness**: Search for a user. Click the detail expand button. Verify all 8 metadata fields render (id, email, legal_name, state, yt_channel_id, yt_display_name_seen, created_at, verified_at). Null fields should show "—" or similar, not "null" or "undefined".
2. **Suspended user**: Find a suspended user (or suspend one via API). Verify the SUSPENDED pill appears and the detail panel shows `suspended_at` with a timestamp.
3. **Deleted user**: Check that deleted users (if any) show `deleted_at` and a visual indicator.
4. **Pre-fill links**: Click "Grant attendance" link on a user row. Verify the attendance form's user ID field is pre-filled with the correct ULID. Same for "Revoke certificate" link.
5. **Cert summary**: Verify the cert count breakdown (pending/generated/delivered/revoked) matches what `/api/admin/user/{id}/certs` returns.
6. **XSS safety**: Create a user with `legal_name` containing `<script>alert(1)</script>`. Verify it renders as escaped text, not executable HTML.

## Phase 6: Cron trigger buttons

1. **Button rendering**: Open admin.html. Verify 6 buttons appear in the Manual Triggers section: purge, security_alerts, weekly_digest, cert_nudge, link_enrichment, all.
2. **Confirmation prompt**: Click a trigger button. Verify a confirmation dialog appears before the POST fires.
3. **Auth forwarding**: Verify the POST to the purge worker URL includes the correct `Authorization: Bearer` header. Check browser DevTools Network tab.
4. **Success/failure feedback**: After triggering, verify the UI shows a success or error message inline. Test with an intentionally wrong token to see the error path.
5. **"All" button**: Trigger "all" and verify it executes without error. Check that it doesn't cause a rate-limit trip on subsequent button presses.
6. **URL correctness**: Verify the hardcoded purge worker URL `https://sc-cpe-purge.ericrihm.workers.dev/` is correct and reachable.

## Phase 7: Test suite integrity

1. **Run full suite**: `bash scripts/test.sh` — all tests must pass (expect 318+ tests, 0 failures).
2. **New test file coverage**: Verify these 3 files are listed in `scripts/test.sh`:
   - `pages/functions/api/admin/analytics/analytics.test.mjs`
   - `pages/functions/api/admin/new-admin-features.test.mjs`
   - `pages/functions/api/me/user-features.test.mjs`
3. **Parity tests**: Run `node scripts/test_chain_parity.mjs` and `node scripts/test_source_parity.mjs` to confirm audit chain canonical form and heartbeat source parity still hold.
4. **E2E test**: Run `node scripts/test_e2e.mjs` — the register-attend-cert-verify pipeline should still pass.

## Phase 8: Cross-cutting integration checks

1. **Heartbeat parity**: Confirm `pages/functions/_heartbeat.js` and `workers/purge/src/index.js` have identical `EXPECTED_CADENCE_S` entries. No new crons were added, but verify nothing was accidentally modified.
2. **CSP compliance**: Verify no inline `<script>` was introduced in admin.html or dashboard.html. All JS must be in external files (`admin.js`, `dashboard.js`). Check `_middleware.js` CSP header still has `script-src 'self'`.
3. **Rate limiting**: Each new admin endpoint should have rate limiting. Verify:
   - `/api/admin/streams` has rate limit (60/hr per admin)
   - `/api/admin/analytics/*` endpoints have rate limits
   - `/api/admin/suspend` has rate limit
   - `/api/admin/email-suppression` has rate limit
4. **Audit trail**: Verify these admin actions write audit log entries:
   - Suspend/unsuspend a user
   - Delete an email suppression entry
   - Cert resend (user-initiated)
5. **Dashboard token isolation**: Verify badge URLs use `badge_token` (not `dashboard_token`). Check that the dashboard email prefs POST uses the CSRF same-origin check.
6. **Kill switch interaction**: Toggle a kill switch (e.g., disable `/api/register`). Verify the analytics endpoints still work — they should not be affected by public endpoint kill switches.
7. **Schema alignment**: Run `bash scripts/check_schema.sh` to confirm `db/schema.sql` matches live D1. The ops-polish bundle added no migrations, but verify no drift exists.

## Phase 9: Documentation review

1. **`docs/DEV_SETUP.md`**: Follow the setup instructions on a clean checkout. Verify every command works. Check that the preview environment table matches `wrangler.toml` `[env.preview]` bindings.
2. **`docs/ADMIN_ONBOARDING.md`**: Walk through each "Common admin tasks" section against the actual admin.html UI. Verify the dashboard section table matches what's actually rendered. Confirm emergency procedures match the actual kill switch and cron trigger UX.
3. **`CLAUDE.md`**: Verify the ops-polish entry accurately describes what was shipped. Verify the "Where to look" section includes DEV_SETUP.md and ADMIN_ONBOARDING.md.
4. **`README.md`**: Verify the API surface table includes `/api/admin/streams`, `/api/admin/suspend`, and `/api/admin/email-suppression`. Verify the endpoint count in the `<summary>` tag is correct (49).

## Phase 10: Security spot-check

1. **XSS in admin.js**: Grep for any remaining `innerHTML` assignments that don't use `escapeHtml()`. All dynamic content in admin.js must be escaped or use `textContent`/DOM methods.
2. **CSRF on new endpoints**: Verify `/api/me/{token}/cert-resend/{cert_id}` calls `isSameOrigin()`. Verify prefs POST calls `isSameOrigin()`.
3. **Auth on admin endpoints**: Verify every admin endpoint calls `isAdmin()` and returns 401 on failure. Check streams, analytics/*, suspend, email-suppression.
4. **Input validation**: Verify the streams `?days=` param is parseInt'd and clamped. Verify the suspend endpoint validates `user_id` and `reason` fields.
5. **Error message leakage**: Verify admin endpoint error responses don't leak stack traces, SQL, or internal paths. Check that 500 errors return a generic message.

---

**Priority**: Phases 1-3 are critical (new endpoints and rendering). Phase 8 (integration) is high priority. Phases 4-7 and 9-10 are important but lower blast radius.

Fix any bugs found. Commit each fix separately with descriptive messages. Run `bash scripts/test.sh` after each fix. When all phases pass, push and report a summary of findings and fixes.
