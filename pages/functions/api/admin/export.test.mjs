import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet } from "./export.js";

const BASE = "https://sc-cpe-web.pages.dev";

function auth(url) {
    return new Request(url, {
        headers: { Authorization: "Bearer adm" },
    });
}

function stubDB(overrides = {}) {
    return {
        prepare(sql) {
            const handler = Object.entries(overrides).find(([p]) =>
                new RegExp(p, "i").test(sql)
            );
            const stmt = {
                bind(...args) { return stmt; },
                all: async () => handler ? { results: handler[1](sql) } : { results: [] },
            };
            return stmt;
        },
    };
}

test("export: unauthorized → 401", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/export?type=users`),
    });
    assert.equal(r.status, 401);
});

test("export: missing type → 400", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/export`),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_type");
});

test("export: invalid type → 400", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/export?type=secrets`),
    });
    assert.equal(r.status, 400);
});

test("export: users CSV has correct headers", async () => {
    const db = stubDB({
        "FROM users": () => [
            { id: "01U", email: "test@x.com", legal_name: "Test User",
              yt_channel_id: "UC123", state: "active", show_on_leaderboard: 1,
              current_streak: 5, longest_streak: 10, last_attendance_date: "2026-04-20",
              created_at: "2026-01-01", verified_at: "2026-01-02" },
        ],
    });
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/export?type=users`),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Type"), "text/csv; charset=utf-8");
    assert.ok(r.headers.get("Content-Disposition").includes("sc-cpe-users-"));
    const body = await r.text();
    assert.ok(body.startsWith("id,email,legal_name"));
    assert.ok(body.includes("test@x.com"));
});

test("export: attendance CSV returns rows", async () => {
    const db = stubDB({
        "FROM attendance": () => [
            { user_id: "01U", email: "t@t.com", legal_name: "T",
              stream_id: "01S", scheduled_date: "2026-04-20", yt_video_id: "abc",
              title: "DTB", earned_cpe: 0.5, source: "poller",
              first_msg_at: "2026-04-20T14:30:00Z", created_at: "2026-04-20T14:30:00Z" },
        ],
    });
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/export?type=attendance`),
    });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(body.includes("user_id,email"));
    assert.ok(body.includes("poller"));
});

test("export: certs CSV returns rows", async () => {
    const db = stubDB({
        "FROM certs": () => [
            { id: "01C", public_token: "abc", user_id: "01U", email: "t@t.com",
              legal_name: "T", period_yyyymm: "202604", cpe_total: 5,
              sessions_count: 10, cert_kind: "bundled", state: "generated",
              generated_at: "2026-04-30", delivered_at: null, created_at: "2026-04-30" },
        ],
    });
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/export?type=certs`),
    });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(body.includes("cert_id,public_token"));
    assert.ok(body.includes("bundled"));
});

test("export: CSV escapes commas and quotes", async () => {
    const db = stubDB({
        "FROM users": () => [
            { id: "01U", email: "t@t.com", legal_name: 'O"Brien, Jr.',
              yt_channel_id: null, state: "active", show_on_leaderboard: 0,
              current_streak: 0, longest_streak: 0, last_attendance_date: null,
              created_at: "2026-01-01", verified_at: null },
        ],
    });
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/export?type=users`),
    });
    const body = await r.text();
    assert.ok(body.includes('"O""Brien, Jr."'));
});
