# Claude Code Healing Session

Paste this into a Claude Code session in the `sc-cpe` directory when you
receive a self-heal escalation alert (Discord or GitHub issue).

---

## Quick triage prompt

```
SC-CPE self-healing escalated. Diagnose and fix.

1. Read CLAUDE.md for project context
2. Read docs/RUNBOOK.md for ops procedures  
3. Check current state:
   - curl -s https://sc-cpe-web.pages.dev/api/health | jq .
   - ADMIN_TOKEN="$(cat ~/.cloudflare/sc-cpe-admin-token)" curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://sc-cpe-web.pages.dev/api/admin/ops-stats | jq '.warnings'
   - gh run list --limit 10
   - gh issue list --label auto-heal-escalation --limit 3
4. Read the most recent escalation issue for the diagnostic bundle
5. Identify root cause and either fix directly or provide instructions
```

## Per-source playbooks

### poller stale

Poller is a CF Worker cron (no HTTP trigger). Common causes:
- **YouTube quota exhausted**: Circuit breaker trips for 15min. Check KV
  key `circuit.youtube_quota`. If set, wait for expiry.
- **OAuth token expired**: Refresh token may need rotation.
  Check `gh run view <latest-poller-deploy> --log` for auth errors.
  Fix: `node scripts/get_oauth_token.mjs <client_secret.json>` then
  update worker secrets.
- **Worker crashed**: Check CF dashboard → Workers → `sc-cpe-poller` →
  Logs. If crashing, redeploy: `cd workers/poller && wrangler deploy`

### email_sender stale

CF Worker cron, no HTTP trigger. Common causes:
- **Resend API key rotated**: Check `RESEND_API_KEY` secret in CF.
- **Resend rate limit**: Check ops-stats `resend_quota_95pct` warning.
- **Worker crash**: Redeploy: `cd workers/email-sender && wrangler deploy`

### purge / security_alerts / link_enrichment stale

Purge worker has an on-demand HTTP trigger:
```sh
ADMIN_TOKEN="$(cat ~/.cloudflare/sc-cpe-admin-token)"
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://sc-cpe-purge.ericrihm.workers.dev/?only=all"
```

If that returns 200 but heartbeat doesn't update, the issue is in the
purge logic itself. Check CF logs.

### cert-sign-pending stalled

The cert pipeline Python workflow runs every 2h. Re-trigger manually:
```sh
gh workflow run cert-sign-pending.yml
```

If it fails, check the run log for PDF signing errors:
```sh
gh run list --workflow=cert-sign-pending.yml --limit 3
gh run view <id> --log-failed
```

### canary stale

Canary is the hourly smoke test. If stale, the smoke suite is failing:
```sh
gh run list --workflow=smoke.yml --limit 5
gh run view <latest-failed> --log-failed
```

Fix the underlying smoke failure (usually a deploy regression), then
re-run: `gh workflow run smoke.yml`

### audit chain broken

**Do not attempt automated repair.** Follow RUNBOOK "Incident steps":
1. Freeze grants (disable poller cron)
2. Pull D1 export
3. Run `scripts/verify_audit_chain.py`
4. Identify divergent row
5. Append `chain_incident_noted` audit row
6. Rotate ADMIN_TOKEN if tampering suspected

### email queue stalled (warn:email_queue_stalled)

Check email-sender heartbeat. If sender is running but queue isn't
draining, check for Resend API errors:
```sh
gh run view <latest-email-sender-deploy> --log | grep -i error
```

If Resend is down, queue will drain when it recovers (cursor is
idempotent). No action needed unless queue is >1000.
