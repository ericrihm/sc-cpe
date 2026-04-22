# Analytics Dashboard Design

## Overview

A dedicated admin analytics page (`/analytics.html`) that surfaces growth,
engagement, cert health, and system reliability trends. Separate from the
existing ops dashboard (`/admin.html`) which focuses on real-time health.

Auth: bearer token (ADMIN_TOKEN), same as all admin endpoints.

## Architecture

Four sectioned API endpoints, fetched in parallel by the page:

```
pages/functions/api/admin/analytics/
  growth.js        — registrations, verifications, active users over time
  engagement.js    — attendance rates, stream participation, streaks
  certs.js         — issuance counts, delivery latency, view rates
  system.js        — email delivery, heartbeat history, appeal turnaround
```

Each endpoint accepts query params:
- `range` — `7d`, `30d`, `90d`, `all` (default: `30d`)
- `granularity` — `daily`, `weekly`, `monthly` (default: auto based on range)

Auto-granularity: 7d→daily, 30d→daily, 90d→weekly, all→monthly.

### Frontend

New files:
- `pages/analytics.html` — admin analytics page
- `pages/analytics.js` — fetch + render logic
- `pages/analytics.css` — dashboard styling

Chart library: Chart.js loaded from CDN (`https://cdn.jsdelivr.net/npm/chart.js`).
CSP `script-src` already allows `'self'` — will need to add the CDN origin
to the CSP in `_middleware.js`, or self-host the minified bundle. Self-hosting
is preferred to avoid CDN dependency and keep the strict CSP.

Link from admin.html → analytics.html in the nav.

## Panel Designs

### 1. Growth Panel (`/api/admin/analytics/growth`)

**Headline cards:**
- Total registered users
- Verified users (completed email verification)
- Active users (attended in last 30 days)
- New registrations this period

**Chart:** Line chart — daily registrations + cumulative users over time.

**D1 queries:**
```sql
-- headline counts
SELECT COUNT(*) FROM users WHERE state='active';
SELECT COUNT(*) FROM users WHERE verified_at IS NOT NULL;
SELECT COUNT(DISTINCT user_id) FROM attendance
  WHERE created_at >= date('now', '-30 days');

-- time series: registrations per day
SELECT date(created_at) as day, COUNT(*) as count
FROM users
WHERE created_at >= ?1
GROUP BY day ORDER BY day;
```

### 2. Engagement Panel (`/api/admin/analytics/engagement`)

**Headline cards:**
- Avg attendance per stream (this period)
- Total CPE awarded (this period)
- Median streak length
- Streams with zero attendance

**Chart:** Line chart — daily attendance count. Optional secondary axis
for distinct_attendees from the streams table.

**D1 queries:**
```sql
-- attendance per day
SELECT s.scheduled_date as day, COUNT(*) as attended
FROM attendance a JOIN streams s ON a.stream_id = s.id
WHERE s.scheduled_date >= ?1
GROUP BY day ORDER BY day;

-- avg per stream
SELECT AVG(cnt) FROM (
  SELECT COUNT(*) as cnt FROM attendance
  GROUP BY stream_id
) WHERE stream_id IN (SELECT id FROM streams WHERE scheduled_date >= ?1);
```

### 3. Certificates Panel (`/api/admin/analytics/certs`)

**Headline cards:**
- Certs issued this period
- Avg generation-to-delivery time
- First-view rate (% of delivered certs that were viewed)
- Pending certs now

**Chart:** Bar chart — certs issued per month (natural grouping by
`period_yyyymm`). Line overlay for avg delivery latency.

**D1 queries:**
```sql
-- issued per month
SELECT period_yyyymm, COUNT(*) as count
FROM certs WHERE state IN ('generated','delivered','viewed')
GROUP BY period_yyyymm ORDER BY period_yyyymm;

-- delivery latency (seconds)
SELECT AVG(julianday(delivered_at) - julianday(created_at)) * 86400 as avg_secs
FROM certs WHERE delivered_at IS NOT NULL AND created_at >= ?1;

-- view rate
SELECT
  COUNT(CASE WHEN first_viewed_at IS NOT NULL THEN 1 END) as viewed,
  COUNT(*) as total
FROM certs WHERE delivered_at IS NOT NULL;
```

### 4. System Health Panel (`/api/admin/analytics/system`)

**Headline cards:**
- Email success rate (sent / total)
- Emails sent this period
- Open appeals
- Avg appeal resolution time

**Chart:** Line chart — emails sent per day. Stacked with
failures if any.

**D1 queries:**
```sql
-- email stats
SELECT date(created_at) as day,
  COUNT(CASE WHEN state='sent' THEN 1 END) as sent,
  COUNT(CASE WHEN state='failed' THEN 1 END) as failed
FROM email_outbox WHERE created_at >= ?1
GROUP BY day ORDER BY day;

-- appeal resolution time
SELECT AVG(julianday(resolved_at) - julianday(created_at)) * 86400 as avg_secs
FROM appeals WHERE resolved_at IS NOT NULL AND created_at >= ?1;
```

## UI Layout

```
┌─────────────────────────────────────────────────┐
│  SC-CPE Analytics          [7d] [30d] [90d] [All]│
├─────────────────────────────────────────────────┤
│  GROWTH                                          │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐           │
│  │ 142  │ │ 98   │ │ 34   │ │ +12  │           │
│  │Users │ │Verified│Active │ │ New  │           │
│  └──────┘ └──────┘ └──────┘ └──────┘           │
│  [═══════ registration trend line ═══════════]   │
├─────────────────────────────────────────────────┤
│  ENGAGEMENT                                      │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐           │
│  │ 8.3  │ │ 204  │ │  5   │ │  0   │           │
│  │Avg/  │ │CPE   │ │Med.  │ │Empty │           │
│  │Stream│ │Earned│ │Streak│ │Shows │           │
│  └──────┘ └──────┘ └──────┘ └──────┘           │
│  [═══════ daily attendance line ═════════════]   │
├─────────────────────────────────────────────────┤
│  CERTIFICATES                                    │
│  ... (same pattern) ...                          │
├─────────────────────────────────────────────────┤
│  SYSTEM HEALTH                                   │
│  ... (same pattern) ...                          │
└─────────────────────────────────────────────────┘
```

## File Changes Summary

**New files (7):**
- `pages/functions/api/admin/analytics/growth.js`
- `pages/functions/api/admin/analytics/engagement.js`
- `pages/functions/api/admin/analytics/certs.js`
- `pages/functions/api/admin/analytics/system.js`
- `pages/analytics.html`
- `pages/analytics.js`
- `pages/analytics.css`

**Modified files (2):**
- `pages/admin.html` — add nav link to analytics
- `pages/_middleware.js` — add Chart.js CDN to CSP if not self-hosting

**Chart.js strategy:** Self-host `chart.umd.min.js` in `pages/lib/` to
avoid CDN CSP exception and keep `script-src 'self'` unchanged.
Download from npm or CDN at build time.

## Auth & Security

- All analytics endpoints use `isAdmin(request, env)` from `_lib.js`
- No PII in responses — aggregate counts only, no emails or names
- Rate limiting via existing `rateLimit()` helper
- No CSRF concern (bearer token auth, not cookie-based)

## Constraints

- D1 has no window functions — streak calculations use application logic
  or self-joins
- No pre-aggregation tables — all queries run on raw tables. D1 is fast
  enough for the data volume (~150 users, ~250 streams, ~2000 attendance
  rows). If it gets slow, add a materialized view later.
- Granularity grouping uses SQLite `date()` / `strftime()` functions
