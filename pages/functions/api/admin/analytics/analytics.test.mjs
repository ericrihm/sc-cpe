import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet as growthGet } from "./growth.js";
import { onRequestGet as engagementGet } from "./engagement.js";
import { onRequestGet as certsGet } from "./certs.js";
import { onRequestGet as systemGet } from "./system.js";

const BASE = "https://sc-cpe-web.pages.dev";

function auth(url) {
    return new Request(url, {
        headers: { Authorization: "Bearer adm" },
    });
}

function stubDB(overrides = {}) {
    return {
        prepare(sql) {
            const handler = Object.entries(overrides).find(([pattern]) =>
                new RegExp(pattern, "i").test(sql)
            );
            let binds = [];
            const stmt = {
                bind(...args) { binds = args; return stmt; },
                first: async () => handler ? handler[1](sql, binds) : null,
                all: async () => handler ? { results: handler[1](sql, binds) } : { results: [] },
                run: async () => ({ meta: {} }),
            };
            return stmt;
        },
    };
}

function analyticsDB() {
    return stubDB({
        "COUNT.*FROM users": () => ({ n: 10 }),
        "COUNT.*FROM attendance": () => ({ n: 5 }),
        "COUNT.*DISTINCT": () => ({ n: 8 }),
        "AVG": () => ({ avg_att: 12.3, avg_secs: 3600, total: 100 }),
        "SUM": () => ({ total: 456.5 }),
        "SELECT.*period": (sql) => [],
        "COUNT.*FROM certs": () => ({ n: 20 }),
        "COUNT.*FROM streams": () => ({ n: 2 }),
        "CASE WHEN state": () => ({ sent: 90, failed: 5, total: 100 }),
        "CASE WHEN first_viewed": () => ({ viewed: 80, total: 100 }),
        "FROM email_outbox": () => ({ sent: 90, failed: 5, total: 100 }),
        "FROM appeals": () => ({ n: 3 }),
    });
}

// ── growth ──────────────────────────────────────────────────────────────

test("analytics/growth: unauthorized → 401", async () => {
    const r = await growthGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/analytics/growth`),
    });
    assert.equal(r.status, 401);
});

test("analytics/growth: valid → 200 with headlines and series", async () => {
    const db = stubDB({
        "deleted_at IS NULL": () => ({ n: 10 }),
        "state = 'active'": () => ({ n: 8 }),
        "verified_at IS NOT NULL": () => ({ n: 9 }),
        "DISTINCT user_id": () => ({ n: 5 }),
        "GROUP BY period": () => [],
        "COUNT.*FROM users": () => ({ n: 3 }),
    });
    const r = await growthGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/analytics/growth?range=30d`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok("total_users" in j.headlines);
    assert.ok("active_users" in j.headlines);
    assert.ok("verified_users" in j.headlines);
    assert.ok("new_registrations" in j.headlines);
    assert.ok(Array.isArray(j.series));
});

// ── engagement ──────────────────────────────────────────────────────────

test("analytics/engagement: unauthorized → 401", async () => {
    const r = await engagementGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/analytics/engagement`),
    });
    assert.equal(r.status, 401);
});

test("analytics/engagement: valid → 200 with attendance data", async () => {
    const r = await engagementGet({
        env: { DB: analyticsDB(), ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/analytics/engagement?range=7d`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok("avg_attendance_per_stream" in j.headlines);
    assert.ok("total_cpe_awarded" in j.headlines);
    assert.ok(Array.isArray(j.series));
});

// ── certs ───────────────────────────────────────────────────────────────

test("analytics/certs: unauthorized → 401", async () => {
    const r = await certsGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/analytics/certs`),
    });
    assert.equal(r.status, 401);
});

test("analytics/certs: valid → 200 with cert stats", async () => {
    const r = await certsGet({
        env: { DB: analyticsDB(), ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/analytics/certs?range=90d`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok("issued_this_period" in j.headlines);
    assert.ok("pending_now" in j.headlines);
    assert.ok(Array.isArray(j.series));
});

// ── system ──────────────────────────────────────────────────────────────

test("analytics/system: unauthorized → 401", async () => {
    const r = await systemGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/analytics/system`),
    });
    assert.equal(r.status, 401);
});

test("analytics/system: valid → 200 with email throughput", async () => {
    const r = await systemGet({
        env: { DB: analyticsDB(), ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/analytics/system?range=all`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok("emails_sent" in j.headlines);
    assert.ok("appeals_open" in j.headlines);
    assert.ok(Array.isArray(j.series));
});
