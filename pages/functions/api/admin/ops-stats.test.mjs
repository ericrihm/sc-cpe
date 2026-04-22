// Tests for /api/admin/ops-stats. Guards the backlog-visibility fields
// added in the launch-prep PR: a silent email-sender outage previously
// showed up only as a stale-heartbeat digest the next day; ops-stats now
// surfaces backlog age and pending-cert age so the admin dashboard shows
// it immediately.

import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet as opsStatsGet, computeWarnings } from "./ops-stats.js";

const BASE = "https://sc-cpe-web.pages.dev";

// Dispatch by SQL-regex; each rule returns {first: row} for .first() calls.
function dbFor(rules) {
    return {
        prepare(sql) {
            const rule = rules.find(r => r.match.test(sql));
            if (!rule) throw new Error("no mock rule for: " + sql.slice(0, 90));
            let binds = [];
            const stmt = {
                bind(...args) { binds = args; return stmt; },
                first: async () => rule.handler(sql, binds),
            };
            return stmt;
        },
    };
}

// Default row set — nothing aging, all zero. Rules are order-sensitive: the
// first matching regex wins in dbFor(), so put the more-specific patterns
// (MIN(created_at), WHERE state='pending') BEFORE their generic COUNT(*)
// cousins for the same table.
function cleanRules(overrides = {}) {
    return [
        // email_outbox specific (MIN must precede COUNT because both match "email_outbox WHERE state = 'queued'")
        { match: /MIN\(created_at\).*email_outbox WHERE state = 'queued'/, handler: () => overrides.oldestQueued ?? ({ ts: null }) },
        { match: /MIN\(created_at\).*email_outbox WHERE state = 'failed'/, handler: () => overrides.oldestFailed ?? ({ ts: null }) },
        { match: /FROM email_outbox WHERE state = 'queued'/, handler: () => overrides.queuedCount ?? ({ n: 0 }) },
        { match: /FROM email_outbox WHERE state = 'failed'/, handler: () => overrides.failedCount ?? ({ n: 0 }) },
        { match: /FROM email_outbox WHERE state = 'sent'/, handler: () => ({ n: 120 }) },
        // certs specific (MIN must precede both the pending COUNT and the "FROM certs" default)
        { match: /MIN\(created_at\).*FROM certs WHERE state = 'pending'/, handler: () => overrides.oldestPending ?? ({ ts: null }) },
        { match: /FROM certs WHERE state = 'pending'/, handler: () => overrides.pendingCount ?? ({ n: 0 }) },
        { match: /FROM certs WHERE created_at/, handler: () => ({ n: 4 }) },
        { match: /SELECT COUNT\(\*\) AS n FROM certs$/, handler: () => ({ n: 20 }) },
        // users / attendance / appeals
        { match: /FROM users WHERE deleted_at IS NULL AND \(email LIKE/, handler: () => ({ n: 0 }) },
        { match: /COUNT\(\*\).*FROM users WHERE deleted_at IS NULL$/, handler: () => ({ n: 42 }) },
        { match: /FROM users WHERE state = 'active'/, handler: () => ({ n: 30 }) },
        { match: /FROM users WHERE state = 'pending_verification'/, handler: () => ({ n: 2 }) },
        { match: /FROM attendance WHERE first_msg_sha256/, handler: () => ({ n: 0 }) },
        { match: /FROM attendance WHERE created_at/, handler: () => ({ n: 17 }) },
        { match: /FROM appeals WHERE state = 'open'/, handler: () => ({ n: 0 }) },
        { match: /FROM streams WHERE id LIKE '01KTEST/, handler: () => ({ n: 0 }) },
        { match: /FROM audit_log ORDER BY ts DESC/, handler: () => ({ id: "01X", ts: "2026-04-16T00:00:00Z", prev_hash: "abc" }) },
        { match: /detail_json FROM heartbeats WHERE source = 'poller'/, handler: () => overrides.pollerBeat ?? ({ detail_json: '{"auth_method":"oauth","at":"2026-04-22T10:00:00Z"}' }) },
    ];
}

function withAuth(url) {
    return new Request(url, { headers: { Authorization: "Bearer adm" } });
}

test("ops-stats: clean state — new fields present with zero/null defaults", async () => {
    const r = await opsStatsGet({
        env: { DB: dbFor(cleanRules()), ADMIN_TOKEN: "adm" },
        request: withAuth(`${BASE}/api/admin/ops-stats`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.email_outbox.queued, 0);
    assert.equal(j.email_outbox.failed, 0);
    assert.equal(j.email_outbox.sent_24h, 120);
    assert.equal(j.email_outbox.oldest_queued_age_seconds, null,
        "null when no queued rows exist");
    assert.equal(j.email_outbox.oldest_failed_age_seconds, null);
    assert.equal(j.certs.pending, 0);
    assert.equal(j.certs.oldest_pending_age_seconds, null);
});

test("ops-stats: backlog aging — oldest_queued_age_seconds reflects time since MIN(created_at)", async () => {
    // Queue holds 3 rows, oldest was inserted ~47 minutes ago.
    const oldestIso = new Date(Date.now() - 47 * 60 * 1000).toISOString();
    const r = await opsStatsGet({
        env: {
            DB: dbFor(cleanRules({
                queuedCount: { n: 3 },
                oldestQueued: { ts: oldestIso },
            })),
            ADMIN_TOKEN: "adm",
        },
        request: withAuth(`${BASE}/api/admin/ops-stats`),
    });
    const j = await r.json();
    assert.equal(j.email_outbox.queued, 3);
    const age = j.email_outbox.oldest_queued_age_seconds;
    assert.ok(age >= 2800 && age <= 2900, `expected ~2820, got ${age}`);
});

test("ops-stats: pending certs — oldest_pending_age_seconds surfaces cron-stuck rows", async () => {
    // One cert has been pending 6 hours — cron should have picked it up 3x by now.
    const pendingIso = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const r = await opsStatsGet({
        env: {
            DB: dbFor(cleanRules({
                pendingCount: { n: 1 },
                oldestPending: { ts: pendingIso },
            })),
            ADMIN_TOKEN: "adm",
        },
        request: withAuth(`${BASE}/api/admin/ops-stats`),
    });
    const j = await r.json();
    assert.equal(j.certs.pending, 1);
    const age = j.certs.oldest_pending_age_seconds;
    assert.ok(age >= 6 * 3600 - 30 && age <= 6 * 3600 + 30, `expected ~21600s, got ${age}`);
});

// ── computeWarnings (pure) ──────────────────────────────────────────────

function baseStats(overrides = {}) {
    return {
        users: { total: 42, active: 30, pending: 2, ...overrides.users },
        last_24h: { attendance: 17, certs_issued: 4, ...overrides.last_24h },
        certs_total: 20,
        appeals_open: 0,
        email_outbox: {
            queued: 0, failed: 0, sent_24h: 100,
            oldest_queued_age_seconds: null, oldest_failed_age_seconds: null,
            ...overrides.email_outbox,
        },
        certs: { pending: 0, oldest_pending_age_seconds: null, ...overrides.certs },
        fixture_pollution: { streams: 0, attendance: 0, users: 0, ...overrides.fixture_pollution },
        poller: { auth_method: "oauth", ...overrides.poller },
        ...overrides,
    };
}

test("computeWarnings: clean state → no warnings", () => {
    const w = computeWarnings(baseStats());
    assert.equal(w.length, 0);
});

test("computeWarnings: Resend quota 80% → warn, 95% → critical", () => {
    const warnSet = computeWarnings(baseStats({ email_outbox: { sent_24h: 2500 } }));
    assert.equal(warnSet.find(x => x.code === "resend_quota_80pct")?.level, "warn");
    const critSet = computeWarnings(baseStats({ email_outbox: { sent_24h: 2900 } }));
    assert.equal(critSet.find(x => x.code === "resend_quota_95pct")?.level, "critical");
});

test("computeWarnings: oldest queued > 10min warns, > 30min critical", () => {
    const warn = computeWarnings(baseStats({ email_outbox: { oldest_queued_age_seconds: 700 } }));
    assert.equal(warn.find(x => x.code === "email_queue_aging")?.level, "warn");
    const crit = computeWarnings(baseStats({ email_outbox: { oldest_queued_age_seconds: 2000 } }));
    assert.equal(crit.find(x => x.code === "email_queue_stalled")?.level, "critical");
});

test("computeWarnings: queued > 100 warns, > 500 critical", () => {
    const warn = computeWarnings(baseStats({ email_outbox: { queued: 150 } }));
    assert.equal(warn.find(x => x.code === "email_queue_elevated")?.level, "warn");
    const crit = computeWarnings(baseStats({ email_outbox: { queued: 600 } }));
    assert.equal(crit.find(x => x.code === "email_queue_deep")?.level, "critical");
});

test("computeWarnings: any failed email triggers warn", () => {
    const w = computeWarnings(baseStats({ email_outbox: { failed: 1 } }));
    assert.equal(w.find(x => x.code === "email_failures")?.level, "warn");
});

test("computeWarnings: pending cert > 4h warns, > 12h critical", () => {
    const warn = computeWarnings(baseStats({ certs: { oldest_pending_age_seconds: 5 * 3600 } }));
    assert.equal(warn.find(x => x.code === "certs_pending_aging")?.level, "warn");
    const crit = computeWarnings(baseStats({ certs: { oldest_pending_age_seconds: 13 * 3600 } }));
    assert.equal(crit.find(x => x.code === "certs_pending_stalled")?.level, "critical");
});

test("computeWarnings: signup abuse — >100 pending and pending > 5× active", () => {
    const w = computeWarnings(baseStats({ users: { total: 200, active: 15, pending: 150 } }));
    assert.equal(w.find(x => x.code === "signup_abuse_pattern")?.level, "warn");
    // Below threshold — low volume should NOT fire
    const none = computeWarnings(baseStats({ users: { total: 50, active: 5, pending: 40 } }));
    assert.equal(none.find(x => x.code === "signup_abuse_pattern"), undefined);
});

test("computeWarnings: fixture pollution in prod triggers warn", () => {
    const w = computeWarnings(baseStats({ fixture_pollution: { streams: 2, attendance: 0, users: 0 } }));
    assert.equal(w.find(x => x.code === "fixture_pollution")?.level, "warn");
});

test("computeWarnings: poller OAuth degraded → warn", () => {
    const w = computeWarnings(baseStats({ poller: { auth_method: "api_key" } }));
    assert.equal(w.find(x => x.code === "poller_oauth_degraded")?.level, "warn");
    const none = computeWarnings(baseStats({ poller: { auth_method: "oauth" } }));
    assert.equal(none.find(x => x.code === "poller_oauth_degraded"), undefined);
});

// ── ops-stats response integration ──────────────────────────────────────

test("ops-stats: unauthorized (wrong bearer) → 401", async () => {
    const r = await opsStatsGet({
        env: { DB: dbFor(cleanRules()), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/ops-stats`, {
            headers: { Authorization: "Bearer wrong" },
        }),
    });
    assert.equal(r.status, 401);
});
