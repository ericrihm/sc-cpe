# SLO — SC-CPE service-level objectives

Starting targets at launch. Reviewed weekly against actuals from
`/api/health`, `/api/admin/heartbeat-status`, `/api/admin/ops-stats`,
and the hourly canary. Revisited monthly — any SLO that's been
consistently exceeded by >2× should be tightened; any chronically
breached SLO should be loosened with a written "why" or fixed.

## User-visible SLOs

| Flow | Target | Measurement | Breach visibility |
| --- | --- | --- | --- |
| Registration email delivered | **99.0 % within 5 min**, 99.9 % within 1 h | `ops-stats.email_outbox.sent_24h` vs queued/failed | `ops-stats.warnings` → `email_queue_stalled` fires Discord via watchdog |
| Recovery email delivered | 99.0 % within 5 min | same | same |
| Live attendance credit | **99.0 % within 60 s** of chat post | poller heartbeat + user-dashboard refresh | `sources[poller].stale` on `/status.html` |
| Per-session cert delivered after request | **99.0 % within 2 h** | `ops-stats.certs.oldest_pending_age_seconds` | `certs_pending_aging` / `_stalled` warning |
| Monthly bundled cert delivered | **99.0 % within 48 h** of month-end cron | `monthly-certs.yml` run status + `certs` rows | workflow red → Discord via PR-G alert-on-failure |
| Cert verification portal available | **99.9 %** | smoke + hourly canary | `sources[canary].stale` on `/status.html` |
| `/api/verify/{token}` response correctness | **100 %** (any wrong answer is P0) | n/a; correctness is audit-chain-verified, not sampled | chain break in `audit-chain-verify` |

## Operational SLOs

| Signal | Target | Why |
| --- | --- | --- |
| Critical `ops-stats.warnings` → Discord | **< 15 min** from condition to alert | watchdog polls every 15 min; no batching |
| Deploy-prod pipeline turnaround | **< 5 min** push → live | currently ~2 min; don't let it drift |
| Rollback ETA (single Worker) | **< 90 s** interactive | see `RUNBOOK.md#rollback`; over 3 min means script it |
| Smoke canary hourly | **< 2 breaches / month** | `smoke.yml` is read-only; a real breach is a real signal |

## Non-goals at launch

Explicit because chasing these without data wastes time:

- **Latency percentiles.** We don't have edge telemetry aggregation today;
  p50/p95 numbers would be guessed. Revisit after a month of real traffic.
- **Zero-downtime guarantees.** Cloudflare Pages deploys are near-instant
  but not formally atomic across all POPs. Acceptable for a CPE issuer;
  escalate only if verify portal drops perceivable uptime.
- **Per-region SLO.** Service is global; localise SLOs only if one region
  produces anomalous breach patterns.

## How to review SLOs

Weekly (on the Monday after the weekly digest lands):

1. Pull `ops-stats.warnings` from the past 7 days (scan your Discord
   `SC-CPE Watchdog` + `SC-CPE Monthly` + `SC-CPE Pending` channel
   history).
2. For each table-row SLO, count observed breaches.
3. If any SLO was breached > 1 % over its window: open a GitHub issue
   with the label `slo-breach` including the warning codes or alerts
   that fired. Triage to a code fix or an SLO relaxation in next week's
   review.
4. If no SLOs were breached for the whole week: the target may be too
   loose — consider tightening in next monthly review.

First monthly review: **one month after public announcement**. Numbers
stabilise around then; tighter targets before that are premature.
