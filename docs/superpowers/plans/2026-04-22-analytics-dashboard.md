# Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an admin analytics page with four panels (Growth, Engagement, Certs, System Health) powered by four API endpoints and rendered with Chart.js.

**Architecture:** Four focused API endpoints under `pages/functions/api/admin/analytics/` each return JSON aggregates from D1. A new `analytics.html` page fetches all four in parallel, renders headline stat cards and Chart.js charts. Self-hosted Chart.js UMD bundle avoids CDN CSP changes. Auth via existing `isAdmin()` bearer token pattern.

**Tech Stack:** Cloudflare Pages Functions (JS), D1 (SQLite), Chart.js 4.x (self-hosted UMD), vanilla JS frontend.

**XSS note:** All dynamic text rendered via `escapeHtml()` helper (same pattern as `admin.js`). The `card()` helper escapes both key and value before inserting into the DOM. Error messages are escaped before display. Chart.js handles its own rendering safely via Canvas API.

---

### Task 1: Download and self-host Chart.js

**Files:**
- Create: `pages/lib/chart.umd.min.js`

- [ ] **Step 1: Download Chart.js UMD bundle**

```bash
mkdir -p pages/lib
curl -L "https://cdn.jsdelivr.net/npm/chart.js@4.4.9/dist/chart.umd.min.js" -o pages/lib/chart.umd.min.js
```

- [ ] **Step 2: Verify the download**

```bash
head -c 100 pages/lib/chart.umd.min.js
wc -c pages/lib/chart.umd.min.js
```

Expected: File starts with `/*!` or similar minified JS header, size ~200-210KB.

- [ ] **Step 3: Commit**

```bash
git add pages/lib/chart.umd.min.js
git commit -m "chore: self-host Chart.js 4.4.9 UMD bundle for analytics"
```

---

### Task 2: Shared analytics query helpers

**Files:**
- Create: `pages/functions/api/admin/analytics/_helpers.js`
- Test: `pages/functions/api/admin/analytics/_helpers.test.mjs`

The four analytics endpoints share range-parsing and date-grouping logic. Extract once here.

- [ ] **Step 1: Write the helpers module**

Create `pages/functions/api/admin/analytics/_helpers.js`:

```js
import { json, isAdmin } from "../../../_lib.js";

export function parseRange(url) {
    const range = url.searchParams.get("range") || "30d";
    const validRanges = { "7d": 7, "30d": 30, "90d": 90 };
    const days = validRanges[range];
    if (range === "all") {
        return { range: "all", since: null, granularity: url.searchParams.get("granularity") || "monthly" };
    }
    if (!days) {
        return { range: "30d", since: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10), granularity: "daily" };
    }
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    const autoGran = days <= 30 ? "daily" : "weekly";
    const granularity = url.searchParams.get("granularity") || autoGran;
    return { range, since, granularity };
}

export function groupByKey(granularity) {
    if (granularity === "weekly") return "strftime('%Y-W%W', {col})";
    if (granularity === "monthly") return "strftime('%Y-%m', {col})";
    return "date({col})";
}

export async function guardAdmin(env, request) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }
    return null;
}
```

- [ ] **Step 2: Write tests for parseRange**

Create `pages/functions/api/admin/analytics/_helpers.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRange, groupByKey } from "./_helpers.js";

test("parseRange: default is 30d daily", () => {
    const url = new URL("https://example.com/api/admin/analytics/growth");
    const r = parseRange(url);
    assert.equal(r.range, "30d");
    assert.equal(r.granularity, "daily");
    assert.ok(r.since, "since should be set");
});

test("parseRange: 7d is daily", () => {
    const url = new URL("https://example.com/?range=7d");
    const r = parseRange(url);
    assert.equal(r.range, "7d");
    assert.equal(r.granularity, "daily");
});

test("parseRange: 90d defaults to weekly", () => {
    const url = new URL("https://example.com/?range=90d");
    const r = parseRange(url);
    assert.equal(r.range, "90d");
    assert.equal(r.granularity, "weekly");
});

test("parseRange: all has no since, defaults monthly", () => {
    const url = new URL("https://example.com/?range=all");
    const r = parseRange(url);
    assert.equal(r.range, "all");
    assert.equal(r.since, null);
    assert.equal(r.granularity, "monthly");
});

test("parseRange: invalid range falls back to 30d", () => {
    const url = new URL("https://example.com/?range=banana");
    const r = parseRange(url);
    assert.equal(r.range, "30d");
});

test("parseRange: explicit granularity override", () => {
    const url = new URL("https://example.com/?range=90d&granularity=daily");
    const r = parseRange(url);
    assert.equal(r.granularity, "daily");
});

test("groupByKey: daily uses date()", () => {
    assert.equal(groupByKey("daily"), "date({col})");
});

test("groupByKey: weekly uses strftime %W", () => {
    assert.equal(groupByKey("weekly"), "strftime('%Y-W%W', {col})");
});

test("groupByKey: monthly uses strftime %Y-%m", () => {
    assert.equal(groupByKey("monthly"), "strftime('%Y-%m', {col})");
});
```

- [ ] **Step 3: Run tests**

```bash
node --test pages/functions/api/admin/analytics/_helpers.test.mjs
```

Expected: All 9 tests pass.

- [ ] **Step 4: Commit**

```bash
git add pages/functions/api/admin/analytics/_helpers.js pages/functions/api/admin/analytics/_helpers.test.mjs
git commit -m "feat(analytics): shared helpers — parseRange, groupByKey, guardAdmin"
```

---

### Task 3: Growth API endpoint

**Files:**
- Create: `pages/functions/api/admin/analytics/growth.js`

- [ ] **Step 1: Write the growth endpoint**

Create `pages/functions/api/admin/analytics/growth.js`:

```js
import { json } from "../../../_lib.js";
import { parseRange, groupByKey, guardAdmin } from "./_helpers.js";

export async function onRequestGet({ request, env }) {
    const denied = await guardAdmin(env, request);
    if (denied) return denied;

    const url = new URL(request.url);
    const { since, granularity } = parseRange(url);

    const grp = groupByKey(granularity).replace("{col}", "created_at");
    const whereClause = since ? "WHERE created_at >= ?1" : "";
    const binds = since ? [since] : [];

    const [totalUsers, activeUsers, verifiedUsers, activeAttenders, newReg, timeSeries] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE state = 'active'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE verified_at IS NOT NULL").first(),
        env.DB.prepare(
            "SELECT COUNT(DISTINCT user_id) AS n FROM attendance WHERE created_at >= ?1"
        ).bind(new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)).first(),
        since
            ? env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?1").bind(since).first()
            : env.DB.prepare("SELECT COUNT(*) AS n FROM users").first(),
        since
            ? env.DB.prepare(
                `SELECT ${grp} AS period, COUNT(*) AS count FROM users ${whereClause} GROUP BY period ORDER BY period`
              ).bind(...binds).all()
            : env.DB.prepare(
                `SELECT ${grp} AS period, COUNT(*) AS count FROM users GROUP BY period ORDER BY period`
              ).all(),
    ]);

    return json({
        ok: true,
        headlines: {
            total_users: totalUsers?.n ?? 0,
            active_users: activeUsers?.n ?? 0,
            verified_users: verifiedUsers?.n ?? 0,
            active_attenders_30d: activeAttenders?.n ?? 0,
            new_registrations: newReg?.n ?? 0,
        },
        series: (timeSeries?.results ?? []).map(r => ({ period: r.period, count: r.count })),
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add pages/functions/api/admin/analytics/growth.js
git commit -m "feat(analytics): growth endpoint — user counts + registration time series"
```

---

### Task 4: Engagement API endpoint

**Files:**
- Create: `pages/functions/api/admin/analytics/engagement.js`

- [ ] **Step 1: Write the engagement endpoint**

Create `pages/functions/api/admin/analytics/engagement.js`:

```js
import { json } from "../../../_lib.js";
import { parseRange, groupByKey, guardAdmin } from "./_helpers.js";

export async function onRequestGet({ request, env }) {
    const denied = await guardAdmin(env, request);
    if (denied) return denied;

    const url = new URL(request.url);
    const { since, granularity } = parseRange(url);

    const grp = groupByKey(granularity).replace("{col}", "s.scheduled_date");
    const whereClause = since ? "WHERE s.scheduled_date >= ?1" : "";
    const binds = since ? [since] : [];

    const streamWhere = since ? "WHERE scheduled_date >= ?1" : "";

    const [avgPerStream, totalCpe, emptyStreams, timeSeries] = await Promise.all([
        since
            ? env.DB.prepare(
                `SELECT AVG(cnt) AS avg_att FROM (
                    SELECT COUNT(*) AS cnt FROM attendance a
                    JOIN streams s ON a.stream_id = s.id
                    WHERE s.scheduled_date >= ?1
                    GROUP BY a.stream_id
                )`
              ).bind(since).first()
            : env.DB.prepare(
                "SELECT AVG(cnt) AS avg_att FROM (SELECT COUNT(*) AS cnt FROM attendance GROUP BY stream_id)"
              ).first(),

        since
            ? env.DB.prepare(
                "SELECT SUM(a.earned_cpe) AS total FROM attendance a JOIN streams s ON a.stream_id = s.id WHERE s.scheduled_date >= ?1"
              ).bind(since).first()
            : env.DB.prepare("SELECT SUM(earned_cpe) AS total FROM attendance").first(),

        since
            ? env.DB.prepare(
                `SELECT COUNT(*) AS n FROM streams ${streamWhere}
                 AND id NOT IN (SELECT DISTINCT stream_id FROM attendance)`
              ).bind(since).first()
            : env.DB.prepare(
                "SELECT COUNT(*) AS n FROM streams WHERE id NOT IN (SELECT DISTINCT stream_id FROM attendance)"
              ).first(),

        since
            ? env.DB.prepare(
                `SELECT ${grp} AS period, COUNT(*) AS count
                 FROM attendance a JOIN streams s ON a.stream_id = s.id
                 ${whereClause} GROUP BY period ORDER BY period`
              ).bind(...binds).all()
            : env.DB.prepare(
                `SELECT ${grp} AS period, COUNT(*) AS count
                 FROM attendance a JOIN streams s ON a.stream_id = s.id
                 GROUP BY period ORDER BY period`
              ).all(),
    ]);

    return json({
        ok: true,
        headlines: {
            avg_attendance_per_stream: Math.round((avgPerStream?.avg_att ?? 0) * 10) / 10,
            total_cpe_awarded: totalCpe?.total ?? 0,
            streams_with_zero_attendance: emptyStreams?.n ?? 0,
        },
        series: (timeSeries?.results ?? []).map(r => ({ period: r.period, count: r.count })),
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add pages/functions/api/admin/analytics/engagement.js
git commit -m "feat(analytics): engagement endpoint — attendance trends + CPE stats"
```

---

### Task 5: Certificates API endpoint

**Files:**
- Create: `pages/functions/api/admin/analytics/certs.js`

- [ ] **Step 1: Write the certs endpoint**

Create `pages/functions/api/admin/analytics/certs.js`:

```js
import { json } from "../../../_lib.js";
import { parseRange, guardAdmin } from "./_helpers.js";

export async function onRequestGet({ request, env }) {
    const denied = await guardAdmin(env, request);
    if (denied) return denied;

    const url = new URL(request.url);
    const { since } = parseRange(url);

    const certStates = "('generated','delivered','viewed_by_auditor')";

    const [issuedPeriod, pending, deliveryLatency, viewRate, timeSeries] = await Promise.all([
        since
            ? env.DB.prepare(
                `SELECT COUNT(*) AS n FROM certs WHERE state IN ${certStates} AND created_at >= ?1`
              ).bind(since).first()
            : env.DB.prepare(
                `SELECT COUNT(*) AS n FROM certs WHERE state IN ${certStates}`
              ).first(),

        env.DB.prepare("SELECT COUNT(*) AS n FROM certs WHERE state = 'pending'").first(),

        since
            ? env.DB.prepare(
                `SELECT AVG(julianday(delivered_at) - julianday(created_at)) * 86400 AS avg_secs
                 FROM certs WHERE delivered_at IS NOT NULL AND created_at >= ?1`
              ).bind(since).first()
            : env.DB.prepare(
                "SELECT AVG(julianday(delivered_at) - julianday(created_at)) * 86400 AS avg_secs FROM certs WHERE delivered_at IS NOT NULL"
              ).first(),

        env.DB.prepare(
            `SELECT COUNT(CASE WHEN first_viewed_at IS NOT NULL THEN 1 END) AS viewed,
                    COUNT(*) AS total
             FROM certs WHERE delivered_at IS NOT NULL`
        ).first(),

        env.DB.prepare(
            `SELECT period_yyyymm AS period, COUNT(*) AS count
             FROM certs WHERE state IN ${certStates}
             GROUP BY period_yyyymm ORDER BY period_yyyymm`
        ).all(),
    ]);

    var avgLatencySecs = deliveryLatency?.avg_secs ?? null;

    return json({
        ok: true,
        headlines: {
            issued_this_period: issuedPeriod?.n ?? 0,
            pending_now: pending?.n ?? 0,
            avg_delivery_seconds: avgLatencySecs != null ? Math.round(avgLatencySecs) : null,
            view_rate_pct: (viewRate?.total ?? 0) > 0
                ? Math.round((viewRate.viewed / viewRate.total) * 100)
                : null,
        },
        series: (timeSeries?.results ?? []).map(r => ({ period: r.period, count: r.count })),
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add pages/functions/api/admin/analytics/certs.js
git commit -m "feat(analytics): certs endpoint — issuance by month, delivery latency, view rate"
```

---

### Task 6: System Health API endpoint

**Files:**
- Create: `pages/functions/api/admin/analytics/system.js`

- [ ] **Step 1: Write the system endpoint**

Create `pages/functions/api/admin/analytics/system.js`:

```js
import { json } from "../../../_lib.js";
import { parseRange, groupByKey, guardAdmin } from "./_helpers.js";

export async function onRequestGet({ request, env }) {
    const denied = await guardAdmin(env, request);
    if (denied) return denied;

    const url = new URL(request.url);
    const { since, granularity } = parseRange(url);

    const grp = groupByKey(granularity).replace("{col}", "created_at");
    const whereClause = since ? "WHERE created_at >= ?1" : "";
    const binds = since ? [since] : [];

    const [emailStats, emailSeries, appealsOpen, appealResTime] = await Promise.all([
        since
            ? env.DB.prepare(
                `SELECT COUNT(CASE WHEN state = 'sent' THEN 1 END) AS sent,
                        COUNT(CASE WHEN state = 'failed' THEN 1 END) AS failed,
                        COUNT(*) AS total
                 FROM email_outbox WHERE created_at >= ?1`
              ).bind(since).first()
            : env.DB.prepare(
                `SELECT COUNT(CASE WHEN state = 'sent' THEN 1 END) AS sent,
                        COUNT(CASE WHEN state = 'failed' THEN 1 END) AS failed,
                        COUNT(*) AS total
                 FROM email_outbox`
              ).first(),

        since
            ? env.DB.prepare(
                `SELECT ${grp} AS period,
                        COUNT(CASE WHEN state = 'sent' THEN 1 END) AS sent,
                        COUNT(CASE WHEN state = 'failed' THEN 1 END) AS failed
                 FROM email_outbox ${whereClause}
                 GROUP BY period ORDER BY period`
              ).bind(...binds).all()
            : env.DB.prepare(
                `SELECT ${grp} AS period,
                        COUNT(CASE WHEN state = 'sent' THEN 1 END) AS sent,
                        COUNT(CASE WHEN state = 'failed' THEN 1 END) AS failed
                 FROM email_outbox
                 GROUP BY period ORDER BY period`
              ).all(),

        env.DB.prepare("SELECT COUNT(*) AS n FROM appeals WHERE state = 'open'").first(),

        since
            ? env.DB.prepare(
                `SELECT AVG(julianday(resolved_at) - julianday(created_at)) * 86400 AS avg_secs
                 FROM appeals WHERE resolved_at IS NOT NULL AND created_at >= ?1`
              ).bind(since).first()
            : env.DB.prepare(
                "SELECT AVG(julianday(resolved_at) - julianday(created_at)) * 86400 AS avg_secs FROM appeals WHERE resolved_at IS NOT NULL"
              ).first(),
    ]);

    var total = emailStats?.total ?? 0;
    var sent = emailStats?.sent ?? 0;

    return json({
        ok: true,
        headlines: {
            email_success_rate_pct: total > 0 ? Math.round((sent / total) * 100) : null,
            emails_sent: sent,
            appeals_open: appealsOpen?.n ?? 0,
            avg_appeal_resolution_seconds: appealResTime?.avg_secs != null
                ? Math.round(appealResTime.avg_secs)
                : null,
        },
        series: (emailSeries?.results ?? []).map(r => ({
            period: r.period,
            sent: r.sent,
            failed: r.failed,
        })),
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add pages/functions/api/admin/analytics/system.js
git commit -m "feat(analytics): system health endpoint — email stats, appeal turnaround"
```

---

### Task 7: Analytics HTML page + CSS

**Files:**
- Create: `pages/analytics.html`
- Create: `pages/analytics.css`

- [ ] **Step 1: Write analytics.html**

Create `pages/analytics.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SC-CPE Analytics</title>
<meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="/admin.css">
<link rel="stylesheet" href="/analytics.css">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="theme-color" content="#0b3d5c">
</head>
<body>
<div class="wrap">
  <h1>SC-CPE Analytics</h1>
  <div class="sub">
    <a href="/admin.html">&larr; Back to Admin</a>
    <span style="margin:0 8px">|</span>
    Usage trends and program health over time.
  </div>

  <div id="login" class="login">
    <input type="password" id="token" placeholder="ADMIN_TOKEN" autocomplete="off">
    <button id="go">Load</button>
  </div>

  <div id="app" style="display:none;">
    <div class="range-bar">
      <button class="range-btn" data-range="7d">7d</button>
      <button class="range-btn active" data-range="30d">30d</button>
      <button class="range-btn" data-range="90d">90d</button>
      <button class="range-btn" data-range="all">All</button>
      <span class="muted" id="ts" style="margin-left:auto;font-size:12px;"></span>
    </div>
    <div id="err"></div>

    <div class="panel" id="panel-growth">
      <div class="section-h">Growth</div>
      <div class="grid" id="growth-cards"></div>
      <div class="chart-wrap"><canvas id="growth-chart"></canvas></div>
    </div>

    <div class="panel" id="panel-engagement">
      <div class="section-h">Engagement</div>
      <div class="grid" id="engagement-cards"></div>
      <div class="chart-wrap"><canvas id="engagement-chart"></canvas></div>
    </div>

    <div class="panel" id="panel-certs">
      <div class="section-h">Certificates</div>
      <div class="grid" id="certs-cards"></div>
      <div class="chart-wrap"><canvas id="certs-chart"></canvas></div>
    </div>

    <div class="panel" id="panel-system">
      <div class="section-h">System Health</div>
      <div class="grid" id="system-cards"></div>
      <div class="chart-wrap"><canvas id="system-chart"></canvas></div>
    </div>
  </div>
</div>

<script src="/lib/chart.umd.min.js"></script>
<script src="/analytics.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write analytics.css**

Create `pages/analytics.css`:

```css
.range-bar {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 18px;
}
.range-btn {
  background: #111820;
  color: #95a4b3;
  border: 1px solid #2a3644;
  padding: 5px 14px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  min-height: 0;
}
.range-btn.active {
  background: #0b3d5c;
  color: #fff;
  border-color: #0b3d5c;
}
.panel {
  margin-bottom: 28px;
}
.chart-wrap {
  background: #111820;
  border: 1px solid #2a3644;
  border-radius: 6px;
  padding: 16px;
  margin-bottom: 8px;
}
.chart-wrap canvas {
  width: 100% !important;
  max-height: 240px;
}
.panel .grid {
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}
```

- [ ] **Step 3: Commit**

```bash
git add pages/analytics.html pages/analytics.css
git commit -m "feat(analytics): HTML page + CSS — four-panel layout with Chart.js"
```

---

### Task 8: Analytics JS (fetch + render)

**Files:**
- Create: `pages/analytics.js`

XSS prevention: All dynamic text is escaped via `escapeHtml()` before DOM insertion — same pattern as the existing `admin.js`. The `card()` helper escapes both the label and value. Error messages are also escaped. Chart.js renders via Canvas API (no DOM string injection).

- [ ] **Step 1: Write analytics.js**

Create `pages/analytics.js` — see the full implementation in the spec. Key points:
- `escapeHtml(s)` used for all user-visible dynamic text
- `card(k, v)` creates DOM elements with escaped content
- `fetchJson()` uses bearer token auth (not cookies)
- `makeChart()` wraps Chart.js with consistent dark-theme styling
- Four `render*()` functions populate cards + charts per panel
- Range buttons re-fetch all four endpoints on click
- Token input supports Enter key

- [ ] **Step 2: Commit**

```bash
git add pages/analytics.js
git commit -m "feat(analytics): JS — fetch four endpoints, render cards + Chart.js graphs"
```

---

### Task 9: Link from admin dashboard

**Files:**
- Modify: `pages/admin.html:16` (the `.sub` div)

- [ ] **Step 1: Add analytics link to admin.html**

In `pages/admin.html`, modify line 16 (the `<div class="sub">` element) to append an analytics link.

- [ ] **Step 2: Commit**

```bash
git add pages/admin.html
git commit -m "feat(analytics): add analytics link to admin dashboard"
```

---

### Task 10: Wire tests into test.sh

**Files:**
- Modify: `scripts/test.sh`

- [ ] **Step 1: Add analytics helper tests to test.sh**

Add `pages/functions/api/admin/analytics/_helpers.test.mjs` to the `node --test` list in `scripts/test.sh`.

- [ ] **Step 2: Run full test suite**

```bash
bash scripts/test.sh
```

Expected: All tests pass including the new analytics helpers.

- [ ] **Step 3: Commit**

```bash
git add scripts/test.sh
git commit -m "test: wire analytics helper tests into test.sh"
```

---

### Task 11: Smoke test against deployed site

**Files:** None (manual verification)

- [ ] **Step 1: Deploy and verify endpoints return valid JSON**

After deploying (merge to main triggers auto-deploy), test each endpoint:

```bash
ADMIN_TOKEN="$(tr -d '\n' < ~/.cloudflare/sc-cpe-admin-token)"
ORIGIN="https://sc-cpe-web.pages.dev"

curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$ORIGIN/api/admin/analytics/growth?range=30d" | python3 -m json.tool | head -20
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$ORIGIN/api/admin/analytics/engagement?range=30d" | python3 -m json.tool | head -20
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$ORIGIN/api/admin/analytics/certs?range=all" | python3 -m json.tool | head -20
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$ORIGIN/api/admin/analytics/system?range=30d" | python3 -m json.tool | head -20
```

Expected: All four return `{"ok":true,...}` with headlines and series arrays.

- [ ] **Step 2: Verify unauthorized access is blocked**

```bash
curl -s "$ORIGIN/api/admin/analytics/growth" | python3 -m json.tool
```

Expected: `{"error":"unauthorized"}` with HTTP 401.

- [ ] **Step 3: Open analytics.html in browser**

Navigate to `$ORIGIN/analytics.html`, paste admin token, verify:
- Four panels load with stat cards
- Charts render with Chart.js
- Range selector (7d/30d/90d/All) re-fetches and re-renders
- Back to Admin link works
