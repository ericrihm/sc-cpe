# SC-CPE Operations Runbook

Owner: ericrihm@gmail.com. Keep entries short — what to do, not why it exists.

## Daily (automatic)

- **05:00 ET** — `sc-cpe-purge` worker fires. Does two things:
  1. Deletes expired raw-chat R2 objects.
  2. Scans `audit_log` for `code_race_detected`, `code_channel_conflict`,
     `appeal_granted` rows since the last successful digest and emails
     `ADMIN_ALERT_EMAIL` via Resend. If no events, no email — silence = clean.
- If you don't see the daily digest on a day with expected events, query
  `heartbeats WHERE source='security_alerts'` — last_status should be `ok`.

## Weekly

- Run `/api/admin/audit-chain-verify` (see below).
- `scripts/verify_audit_chain.py` does the same offline from a D1 dump and
  should match; run it if you want a second opinion independent of the
  Workers runtime.

## Audit chain verification

Endpoint: `GET /api/admin/audit-chain-verify[?limit=N]`

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://sc-cpe-web.pages.dev/api/admin/audit-chain-verify | jq .
```

Happy response: `{"ok":true,"checked":N,"has_unique_index":true}`.

### When `ok:false`

Means one of:

- A row's recomputed `prev_hash` doesn't match the stored value → the chain
  was tampered with OR a row was inserted outside the standard helper.
- `has_unique_index:false` → the partial UNIQUE INDEX on `audit_log(prev_hash)`
  is missing. Concurrent writers can fork the chain. **Recreate the index
  immediately** before taking any further action:

  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_prev_hash_unique
      ON audit_log(prev_hash) WHERE prev_hash IS NOT NULL;
  ```

### Incident steps

1. **Freeze grants.** Disable the poller cron (`wrangler cron trigger --delete`
   on `sc-cpe-poller`) so no new attendance rows land while investigating.
2. Pull a D1 export — `wrangler d1 export sc-cpe --output=forensic-$(date +%s).sql`.
3. Run `scripts/verify_audit_chain.py` against the dump. Identify the first
   divergent row (`id`, `ts`).
4. Diff surrounding rows against prior backups / R2 raw-chat to understand
   what was altered or missed.
5. Do **not** rewrite the chain. Append a `chain_incident_noted` audit row
   via the standard helper describing findings; that preserves the tip for
   downstream auditors.
6. Rotate `ADMIN_TOKEN` if tampering is suspected.

## Smoke-test after deploy

`ORIGIN=https://sc-cpe-web.pages.dev ADMIN_TOKEN=... scripts/smoke_hardening.sh`

Checks HMAC admin compare, CSRF gates, preflight/channel rate-limit, and
audit chain integrity. Any FAIL = roll back or investigate before letting a
briefing run.

## Poller worker

- Lives at `workers/poller/`. Auto-deployed by
  `.github/workflows/deploy-prod.yml` on every merge to `main` (the
  workflow redeploys Pages + all three Workers together; manual
  `wrangler deploy` is break-glass only).
- Race-detection (see `processCodeMatches` in `src/index.js`) is covered
  by the same pipeline — no special handling post-refactor.
- Expected heartbeat: `heartbeats WHERE source='poller'` should tick every
  minute during the ET weekday 08:00–11:00 window.

## Rollback

Every `deploy-prod` run publishes four artefacts: one Pages deployment and
three Worker versions. Rollback is per-artefact — in a real regression you
usually need to roll back ALL of them to the same pre-bad SHA.

### Workers (CLI)

```sh
cd workers/email-sender && wrangler deployments list | head
cd workers/email-sender && wrangler rollback      # interactive, confirms
cd workers/poller       && wrangler rollback
cd workers/purge        && wrangler rollback
```

`wrangler rollback` without an id promotes the deployment immediately
before the current one; pass a specific deployment id to jump further
back. Cursor is idempotent in `email-sender`; the other two crons are
state-less per invocation, so re-running after rollback just re-emits
heartbeats from the older code.

### Pages (dashboard)

No CLI rollback today. Cloudflare dashboard →
[`sc-cpe-web`](https://dash.cloudflare.com) → *Deployments* → pick a prior
successful deployment → *Rollback*. Takes ~10s to propagate.

### Verify after rollback

```sh
ADMIN_TOKEN=... ORIGIN=https://sc-cpe-web.pages.dev scripts/smoke_hardening.sh
curl -fsS https://sc-cpe-web.pages.dev/api/health | jq '.sources[] | {source, stale}'
```

All four cron sources should beat within their cadence; no `stale:true`.

### Rehearsal target

Rehearse a rollback of `email-sender` on any quiet weekday outside the
08:00–11:00 ET poll window. Time it. Under 90 seconds end-to-end is fine;
above 3 minutes means we should script it into a GH Actions workflow
dispatch.

### Break-glass (CI red)

If required checks can't go green and you must ship a fix now: toggle off
the `Require status checks to pass` rule for `main` in *Settings →
Branches*, push the fix directly (admin bypass), re-enable the rule. The
deploy-prod push trigger still fires, and its first job re-runs tests as
a safety net — so a truly broken fix still surfaces in the deploy log
even if you skipped the PR gate.

## Rotating ADMIN_TOKEN

```sh
cd pages && wrangler pages secret put ADMIN_TOKEN
# then update any operator kit / password manager entries
```

The HMAC compare in `isAdmin` means wrong tokens leak nothing about the
expected token's length or bytes — rotating is still prudent on any
suspected exposure.

## Disaster Recovery

### How backups work

- **Weekly** (Sunday 06:00 UTC): GitHub Actions exports D1 via `wrangler d1 export`,
  uploads the SQL dump to R2 bucket `sc-cpe-backups`, and saves a 30-day GitHub
  artifact as secondary copy.
- **Retention:** R2 keeps 90 days (lifecycle rule). GitHub artifacts keep 30 days.
  Local `/tmp` keeps 4 files (rotated).
- **Data loss window:** Up to 7 days (weekly cadence). If this is too wide,
  increase the cron frequency in `.github/workflows/backup.yml`.

### List available backups

```sh
bash scripts/restore_d1.sh --list
```

### Restore from R2

```sh
# Most recent backup
bash scripts/restore_d1.sh --latest --confirm

# Specific backup
bash scripts/restore_d1.sh d1-backup-20260420-060012.sql --confirm
```

**Warning:** This overwrites the production D1 database. All data written
since the backup was taken will be lost.

### Test the restore path

Trigger the backup workflow with `test_restore=true`:

```sh
gh workflow run backup.yml -f test_restore=true
```

This creates a throwaway D1, imports the backup, runs sanity queries, and
deletes the throwaway DB. It does not touch production.

### After a restore

1. Run `scripts/smoke_hardening.sh` to verify endpoints work.
2. Check `/api/admin/audit-chain-verify` — the chain should be intact
   (the backup includes all audit rows).
3. Check heartbeats — cron workers will re-beat on their next tick.
4. Any registrations, attendance, or certs created since the backup was
   taken are lost. Communicate to affected users if applicable.

## DNS: DMARC Record

Add a TXT record for `_dmarc.signalplane.co`:

```
v=DMARC1; p=none; rua=mailto:dmarc-reports@signalplane.co
```

DKIM is configured via Resend. SPF is set. This adds DMARC reporting
without enforcement (`p=none`). Once reports confirm alignment, consider
escalating to `p=quarantine`.

Verify: `dig TXT _dmarc.signalplane.co +short`

## Open Badge Signing Key (Ed25519)

### Initial setup

Generate an Ed25519 keypair and store the private key as a Pages secret:

```sh
node -e "
const crypto = require('crypto');
const kp = crypto.generateKeyPairSync('ed25519');
const der = kp.privateKey.export({ type: 'pkcs8', format: 'der' });
console.log(der.slice(-32).toString('base64'));
"
```

Then store it:

```sh
cd pages && wrangler pages secret put OB_SIGNING_KEY
# paste the base64 string when prompted
```

### Verify

```sh
curl -s https://sc-cpe-web.pages.dev/api/ob/jwks | jq .
```

Should return a JWK with `"kty": "OKP"`, `"crv": "Ed25519"`, and a populated `x` field.

### Rotation

Same as initial setup. Generate a new key, update the secret, redeploy.
After rotation, credentials signed with the old key are no longer verifiable
via the JWKS endpoint. If backward verification matters, keep the old public
key in the JWKS response (multi-key support — add a second entry to the
`keys` array with a different `kid`).
