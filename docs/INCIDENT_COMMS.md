# Incident communications playbook

Short, opinionated, actionable. Use during any user-visible outage or
security event. If you're following this playbook you're already past the
"is this a real incident" bar — act fast.

## Decision tree

1. **Something looks broken in production.**
   - First: reload `/api/health` and `/status.html`. Confirm the signal is real.
   - Check `/api/admin/ops-stats.warnings` on the admin dashboard.
   - If you got a Discord alert, the timestamp there is your incident start.
2. **Is user data or cert integrity at risk?** (exposed PII, forged or
   revoked certs passing verify, audit chain fork)
   - Treat as P0. Kill the relevant public endpoint via the admin
     dashboard's kill-switch panel (`register`, `recover`, `preflight`)
     — buys you time.
   - Then follow the full comms cycle below.
3. **Is the service degraded but intact?** (email backlog, poller stale,
   cert-sign-pending slow)
   - Treat as P1. Short Discord ping only; no public status-page note
     needed unless it exceeds the user-visible SLA (see §2).

## User-visible SLAs (for scoring severity)

| Surface | User-visible SLA | Source of truth |
| --- | --- | --- |
| Registration email | within 5 min | `/api/admin/ops-stats.email_outbox.oldest_queued_age_seconds` |
| Recovery email | within 5 min | same |
| Monthly cert delivery | within 48h of month-end cron | `/api/admin/ops-stats.certs.oldest_pending_age_seconds` |
| Per-session cert delivery | within 2h of request | same |
| Live-attendance credit | within 60s of chat post | poller heartbeat + user dashboard |
| Cert verification portal | always on | `/api/health.sources[source=poller,canary]` |

A cert-verification outage is P0 *regardless* of scale — relying parties
need that endpoint more than users do. Kill-switches do not apply to verify
or download; those stay on.

## Comms cycle (P0 / P1)

### T + 0 to 5 min

1. Post in Discord ops channel. Template:
   ```
   :rotating_light: SC-CPE P0 — <one-line summary>
   Started: <UTC timestamp>
   Impact: <who / what breaks>
   I'm investigating. Next update in 15 min.
   ```
2. If any public endpoint is killed: note which, so colleagues know the
   503s are deliberate.

### T + 15 min

- Update Discord. Keep it factual: what you've found, what you've tried,
  what's next.
- If duration > 15 min AND verify-portal-impacting: post a pinned GitHub
  issue with the `incident` label. Link it in Discord.
- Template for the GitHub issue:
  ```
  Title: [P0 incident] <summary>
  Body: started <ts>; impact <desc>; current status <what's tried>;
        ETA <best guess>. Will update this issue until resolved.
  ```

### During mitigation

- Every state change deserves a Discord line: "attempted X, result Y".
- If you kill-switch an endpoint, say so in Discord and on the GitHub
  issue. If you un-kill, say that too. No silent toggles during an
  incident.

### At resolution

- Discord: "Resolved at <ts>. Root cause: <one line>. User impact: <one
  line>. Post-mortem: <link to issue>."
- Close the GitHub issue with a short post-mortem comment (what, why,
  what we'll do differently).
- Remove any pinned status.html badge you added (when the status page
  grows one).
- Update `/api/admin/ops-stats.warnings` code list if a new class of
  warning would have caught this sooner.

## Pre-written templates

### Registration / recovery outage (users can't sign up or recover)
```
SC-CPE registration/recovery is temporarily unavailable due to a
service issue. Existing accounts and certificates are unaffected —
you can still log in with your dashboard URL and your existing
certificates remain valid and verifiable. We'll post here when it's
back.
```

### Mass email delay
```
Certificate / recovery emails are queued but delayed. We're working
on delivery. No emails will be lost — they're durably queued and
will send as soon as the delay clears.
```

### Verify portal issue
```
The public certificate verification portal is experiencing issues.
Auditors can still verify certificates manually by comparing the
SHA-256 printed on the cert against their own copy. We're treating
this as our highest-priority issue. Next update in 15 min.
```

### Audit-chain integrity alert
```
We detected a potential discrepancy in the certificate audit chain.
Out of an abundance of caution we've paused new certificate issuance
while we investigate. Previously issued certificates are unaffected
and remain verifiable. No user action required.
```

## After any P0

Within 48 hours, open a follow-up issue:
- Five whys analysis.
- One concrete code or process change that would have prevented the
  incident or caught it sooner.
- Wire the change into the next sprint — don't leave it in limbo.
