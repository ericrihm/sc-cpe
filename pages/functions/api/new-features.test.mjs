// Handler-level tests for features shipped 2026-04-24:
//   - Leaderboard streaks (leaderboard.js)
//   - CSV export (admin/export.js)
//   - Public profile (profile/[token].js)
//   - Dashboard streaks API (me/[token].js)
//
// Run: node --test pages/functions/api/new-features.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet as leaderboardGet } from "./leaderboard.js";
import { onRequestGet as exportGet } from "./admin/export.js";
import { onRequestGet as profileGet } from "./profile/[token].js";
import { onRequestGet as meGet } from "./me/[token].js";

// ── helpers ───────────────────────────────────────────────────────────────

function mockDB(rules) {
    return {
        prepare(sql) {
            const rule = rules.find(r => r.match.test(sql));
            if (!rule) throw new Error("no mock rule matched SQL: " + sql.slice(0, 120));
            let binds = [];
            const stmt = {
                bind(...args) { binds = args; return stmt; },
                first: async () => rule.handler(sql, binds).first ?? null,
                all: async () => ({ results: rule.handler(sql, binds).all ?? [] }),
                run: async () => rule.handler(sql, binds).run ?? { meta: {} },
            };
            return stmt;
        },
    };
}

const kvPermissive = { get: async () => null, put: async () => {} };
const kvTripped = { get: async () => "999", put: async () => {} };

function getReq(url) {
    return new Request(url, {
        method: "GET",
        headers: { Origin: new URL(url).origin },
    });
}

function adminReq(url) {
    return new Request(url, {
        method: "GET",
        headers: { Authorization: "Bearer test-admin-token" },
    });
}

// constant-time compare mock for isAdmin
function adminEnv(dbRules) {
    return {
        DB: mockDB(dbRules),
        RATE_KV: kvPermissive,
        ADMIN_TOKEN: "test-admin-token",
    };
}

// ── leaderboard: streak field ───────────────────────────────────────────

test("leaderboard: entries include streak field", async () => {
    const db = mockDB([
        { match: /FROM attendance/, handler: () => ({
            all: [
                { legal_name: "Alice Johnson", cpe_earned: 5, sessions: 10, current_streak: 7 },
                { legal_name: "Bob Smith", cpe_earned: 3, sessions: 6, current_streak: 0 },
            ],
        })},
    ]);
    const r = await leaderboardGet({
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/leaderboard"),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.entries[0].streak, 7);
    assert.equal(j.entries[1].streak, 0);
});

test("leaderboard: null current_streak defaults to 0", async () => {
    const db = mockDB([
        { match: /FROM attendance/, handler: () => ({
            all: [
                { legal_name: "Null User", cpe_earned: 1, sessions: 2, current_streak: null },
            ],
        })},
    ]);
    const r = await leaderboardGet({
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/leaderboard"),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.entries[0].streak, 0);
});

// ── CSV export ──────────────────────────────────────────────────────────

test("export: rejects unauthenticated requests", async () => {
    const r = await exportGet({
        request: getReq("https://sc-cpe-web.pages.dev/api/admin/export?type=users"),
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
    });
    assert.equal(r.status, 401);
});

test("export: rejects invalid type parameter", async () => {
    const r = await exportGet({
        request: adminReq("https://sc-cpe-web.pages.dev/api/admin/export?type=secrets"),
        env: adminEnv([]),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_type");
});

test("export: rejects missing type parameter", async () => {
    const r = await exportGet({
        request: adminReq("https://sc-cpe-web.pages.dev/api/admin/export"),
        env: adminEnv([]),
    });
    assert.equal(r.status, 400);
});

test("export: users CSV returns correct headers and content-type", async () => {
    const env = adminEnv([
        { match: /FROM users/, handler: () => ({
            all: [
                {
                    id: "u1", email: "test@example.com", legal_name: "Test User",
                    yt_channel_id: "ch1", state: "active", show_on_leaderboard: 1,
                    current_streak: 5, longest_streak: 12, last_attendance_date: "2026-04-24",
                    created_at: "2026-04-01T00:00:00Z", verified_at: "2026-04-01T01:00:00Z",
                },
            ],
        })},
    ]);
    const r = await exportGet({
        request: adminReq("https://sc-cpe-web.pages.dev/api/admin/export?type=users"),
        env,
    });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("Content-Type").includes("text/csv"));
    assert.ok(r.headers.get("Content-Disposition").includes("attachment"));
    assert.ok(r.headers.get("Content-Disposition").includes("sc-cpe-users"));
    const csv = await r.text();
    const lines = csv.trim().split("\n");
    assert.ok(lines[0].includes("email"), "header must include email");
    assert.ok(lines[0].includes("current_streak"), "header must include streak");
    assert.equal(lines.length, 2, "header + 1 data row");
    assert.ok(lines[1].includes("test@example.com"));
});

test("export: users CSV escapes commas in legal_name", async () => {
    const env = adminEnv([
        { match: /FROM users/, handler: () => ({
            all: [
                {
                    id: "u1", email: "a@b.com", legal_name: "Last, First",
                    yt_channel_id: null, state: "active", show_on_leaderboard: 0,
                    current_streak: 0, longest_streak: 0, last_attendance_date: null,
                    created_at: "2026-04-01", verified_at: null,
                },
            ],
        })},
    ]);
    const r = await exportGet({
        request: adminReq("https://sc-cpe-web.pages.dev/api/admin/export?type=users"),
        env,
    });
    const csv = await r.text();
    assert.ok(csv.includes('"Last, First"'), "commas in fields must be quoted");
});

test("export: attendance CSV returns correct structure", async () => {
    const env = adminEnv([
        { match: /FROM attendance/, handler: () => ({
            all: [
                {
                    user_id: "u1", email: "a@b.com", legal_name: "Test",
                    stream_id: "s1", scheduled_date: "2026-04-10", yt_video_id: "v1",
                    title: "DTB", earned_cpe: 0.5, source: "poll",
                    first_msg_at: "2026-04-10T10:00:00Z", created_at: "2026-04-10T10:00:01Z",
                },
            ],
        })},
    ]);
    const r = await exportGet({
        request: adminReq("https://sc-cpe-web.pages.dev/api/admin/export?type=attendance"),
        env,
    });
    assert.equal(r.status, 200);
    const csv = await r.text();
    assert.ok(csv.includes("earned_cpe"));
    assert.ok(csv.includes("0.5"));
});

test("export: certs CSV returns correct structure", async () => {
    const env = adminEnv([
        { match: /FROM certs/, handler: () => ({
            all: [
                {
                    id: "c1", public_token: "pt1", user_id: "u1", email: "a@b.com",
                    legal_name: "Test", period_yyyymm: "202604", cpe_total: 5,
                    sessions_count: 10, cert_kind: "bundled", state: "delivered",
                    generated_at: "2026-04-30", delivered_at: "2026-05-01",
                    created_at: "2026-04-30",
                },
            ],
        })},
    ]);
    const r = await exportGet({
        request: adminReq("https://sc-cpe-web.pages.dev/api/admin/export?type=certs"),
        env,
    });
    assert.equal(r.status, 200);
    const csv = await r.text();
    assert.ok(csv.includes("cert_kind"));
    assert.ok(csv.includes("bundled"));
});

// ── public profile ──────────────────────────────────────────────────────

test("profile: short token → 400", async () => {
    const r = await profileGet({
        params: { token: "short" },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/profile/short"),
    });
    assert.equal(r.status, 400);
});

test("profile: unknown badge_token → 404", async () => {
    const db = mockDB([
        { match: /FROM users/, handler: () => ({ first: null }) },
    ]);
    const r = await profileGet({
        params: { token: "a".repeat(64) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/profile/" + "a".repeat(64)),
    });
    assert.equal(r.status, 404);
});

test("profile: valid user → 200 with privacy-safe name", async () => {
    const db = mockDB([
        { match: /FROM users.*WHERE badge_token/s, handler: () => ({
            first: {
                id: "u1", legal_name: "Alice Johnson",
                current_streak: 5, longest_streak: 12,
                last_attendance_date: "2026-04-24",
                created_at: "2026-03-01", verified_at: "2026-03-02",
            },
        })},
        { match: /SUM\(earned_cpe\)/, handler: () => ({ first: { total: 15.5 } }) },
        { match: /COUNT.*FROM attendance/, handler: () => ({ first: { n: 31 } }) },
        { match: /COUNT.*FROM certs/, handler: () => ({ first: { n: 3 } }) },
    ]);
    const r = await profileGet({
        params: { token: "a".repeat(64) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/profile/" + "a".repeat(64)),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.display_name, "Alice J.");
    assert.equal(j.total_cpe, 15.5);
    assert.equal(j.total_sessions, 31);
    assert.equal(j.certs_earned, 3);
    assert.equal(j.current_streak, 5);
    assert.equal(j.longest_streak, 12);
    assert.ok(j.member_since);
});

test("profile: single-name user has no last initial", async () => {
    const db = mockDB([
        { match: /FROM users.*WHERE badge_token/s, handler: () => ({
            first: {
                id: "u1", legal_name: "Madonna",
                current_streak: 0, longest_streak: 0,
                last_attendance_date: null,
                created_at: "2026-03-01", verified_at: null,
            },
        })},
        { match: /SUM\(earned_cpe\)/, handler: () => ({ first: { total: 0 } }) },
        { match: /COUNT.*FROM attendance/, handler: () => ({ first: { n: 0 } }) },
        { match: /COUNT.*FROM certs/, handler: () => ({ first: { n: 0 } }) },
    ]);
    const r = await profileGet({
        params: { token: "a".repeat(64) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/profile/" + "a".repeat(64)),
    });
    const j = await r.json();
    assert.equal(j.display_name, "Madonna");
});

test("profile: rate limit trips → 429", async () => {
    const r = await profileGet({
        params: { token: "a".repeat(64) },
        env: { DB: mockDB([]), RATE_KV: kvTripped },
        request: getReq("https://sc-cpe-web.pages.dev/api/profile/" + "a".repeat(64)),
    });
    assert.equal(r.status, 429);
});

// ── dashboard streaks API (me/[token]) ──────────────────────────────────

test("me/[token]: response includes streaks object from DB", async () => {
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({
            first: {
                id: "u1", email: "a@b.com", legal_name: "Test",
                yt_channel_id: null, yt_display_name_seen: null,
                verification_code: null, code_expires_at: null,
                state: "active", email_prefs: '{}',
                show_on_leaderboard: 0, badge_token: "bt1",
                created_at: "2026-04-01", verified_at: "2026-04-02",
                current_streak: 8, longest_streak: 15,
                last_attendance_date: "2026-04-24",
            },
        })},
        { match: /FROM attendance a JOIN streams/, handler: () => ({ all: [] }) },
        { match: /FROM certs WHERE user_id/, handler: () => ({ all: [] }) },
        { match: /FROM appeals WHERE user_id/, handler: () => ({ all: [] }) },
        { match: /FROM audit_log.*attendance_outside_window/s, handler: () => ({ all: [] }) },
        { match: /FROM streams s.*WHERE s.state/s, handler: () => ({ first: null }) },
    ]);
    const r = await meGet({
        params: { token: "a".repeat(64) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/me/" + "a".repeat(64)),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.streaks, "response must include streaks object");
    assert.equal(j.streaks.current, 8);
    assert.equal(j.streaks.longest, 15);
    assert.equal(j.streaks.last_date, "2026-04-24");
});

test("me/[token]: streaks default to zero for user with no attendance", async () => {
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({
            first: {
                id: "u1", email: "a@b.com", legal_name: "New User",
                yt_channel_id: null, yt_display_name_seen: null,
                verification_code: "ABCD1234", code_expires_at: "2099-01-01",
                state: "pending_verification", email_prefs: '{}',
                show_on_leaderboard: 0, badge_token: null,
                created_at: "2026-04-24", verified_at: null,
                current_streak: 0, longest_streak: 0,
                last_attendance_date: null,
            },
        })},
        { match: /FROM attendance a JOIN streams/, handler: () => ({ all: [] }) },
        { match: /FROM certs WHERE user_id/, handler: () => ({ all: [] }) },
        { match: /FROM appeals WHERE user_id/, handler: () => ({ all: [] }) },
        { match: /FROM audit_log.*attendance_outside_window/s, handler: () => ({ all: [] }) },
        { match: /FROM streams s.*WHERE s.state/s, handler: () => ({ first: null }) },
    ]);
    const r = await meGet({
        params: { token: "a".repeat(64) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/me/" + "a".repeat(64)),
    });
    const j = await r.json();
    assert.equal(j.streaks.current, 0);
    assert.equal(j.streaks.longest, 0);
    assert.equal(j.streaks.last_date, null);
});
