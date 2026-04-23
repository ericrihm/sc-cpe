import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet as usersGet } from "./users.js";
import { onRequestGet as heartbeatGet } from "./heartbeat-status.js";
import { onRequestGet as appealsGet } from "./appeals.js";
import { onRequestPost as resolvePost } from "./appeals/[id]/resolve.js";
import { onRequestGet as userCertsGet } from "./user/[id]/certs.js";
import { onRequestPost as attendancePost } from "./attendance.js";
import { onRequestPost as revokePost } from "./revoke.js";

const BASE = "https://sc-cpe-web.pages.dev";

function auth(url, opts = {}) {
    return new Request(url, {
        ...opts,
        headers: { Authorization: "Bearer adm", ...(opts.headers || {}) },
    });
}

function postAuth(url, body) {
    return auth(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

function stubDB(overrides = {}) {
    const noop = { meta: {} };
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
                run: async () => noop,
            };
            return stmt;
        },
    };
}

function auditDB(overrides = {}) {
    return stubDB({
        ...overrides,
        "INSERT INTO audit_log": () => null,
        "SELECT id, ts, prev_hash FROM audit_log ORDER BY ts DESC": () => ({
            id: "01X", ts: "2026-04-22T00:00:00Z", prev_hash: "abc",
        }),
    });
}

function mkKV(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        get: async (k) => store.get(k) ?? null,
        put: async (k, v) => { store.set(k, v); },
        delete: async (k) => { store.delete(k); },
    };
}

// ── users search ────────────────────────────────────────────────────────

test("users search: unauthorized without bearer → 401", async () => {
    const r = await usersGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/users?q=test`),
    });
    assert.equal(r.status, 401);
});

test("users search: query too short → 400", async () => {
    const r = await usersGet({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/users?q=x`),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "query_required_2_to_200_chars");
});

test("users search: valid query → 200 with users array", async () => {
    const db = auditDB({
        "FROM users u": () => [
            { id: "01ABC", email: "test@example.com", legal_name: "Test User",
              state: "active", attendance_count: 5, cert_count: 1, open_appeal_count: 0 },
        ],
    });
    const r = await usersGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/users?q=test`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.count, 1);
    assert.equal(j.users[0].email, "test@example.com");
});

// ── heartbeat-status ────────────────────────────────────────────────────

test("heartbeat-status: unauthorized → 401", async () => {
    const r = await heartbeatGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/heartbeat-status`),
    });
    assert.equal(r.status, 401);
});

test("heartbeat-status: valid → 200 with sources array", async () => {
    const db = stubDB({
        "FROM heartbeats": () => [
            { source: "poller", last_beat_at: new Date().toISOString(), last_status: "ok", detail_json: null },
        ],
    });
    const r = await heartbeatGet({
        env: {
            DB: db, ADMIN_TOKEN: "adm",
            POLL_WINDOW_TZ: "America/New_York",
            POLL_WINDOW_START_HOUR: "0",
            POLL_WINDOW_END_HOUR: "24",
            POLL_WINDOW_DAYS: "0,1,2,3,4,5,6",
        },
        request: auth(`${BASE}/api/admin/heartbeat-status`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.sources));
    assert.ok(j.sources.length > 0);
});

// ── appeals list ────────────────────────────────────────────────────────

test("appeals: unauthorized → 401", async () => {
    const r = await appealsGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/appeals`),
    });
    assert.equal(r.status, 401);
});

test("appeals: invalid state → 400", async () => {
    const r = await appealsGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/appeals?state=bogus`),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_state");
});

test("appeals: valid request → 200 with appeals array", async () => {
    const db = stubDB({
        "FROM appeals": () => [
            { id: "01APP", user_id: "01U", claimed_date: "2026-04-20",
              state: "open", email: "t@t.com", legal_name: "Test" },
        ],
    });
    const r = await appealsGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/appeals?state=open`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.count, 1);
});

// ── appeal resolve ──────────────────────────────────────────────────────

test("appeal resolve: unauthorized → 401", async () => {
    const r = await resolvePost({
        params: { id: "01APPEAL1234" },
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/appeals/01APPEAL1234/resolve`, { method: "POST" }),
    });
    assert.equal(r.status, 401);
});

test("appeal resolve: invalid decision → 400", async () => {
    const r = await resolvePost({
        params: { id: "01APPEAL1234" },
        env: { DB: auditDB(), ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/appeals/01APPEAL1234/resolve`, {
            decision: "maybe", resolver: "admin1",
        }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_decision");
});

test("appeal resolve: appeal not found → 404", async () => {
    const r = await resolvePost({
        params: { id: "01APPEAL1234" },
        env: { DB: auditDB(), ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/appeals/01APPEAL1234/resolve`, {
            decision: "deny", resolver: "admin1",
        }),
    });
    assert.equal(r.status, 404);
});

test("appeal resolve: deny open appeal → 200", async () => {
    const db = auditDB({
        "FROM appeals WHERE id": (sql, binds) => ({
            id: "01APPEAL1234", user_id: "01U", claimed_stream_id: "01S", state: "open",
        }),
        "UPDATE appeals": () => null,
    });
    const r = await resolvePost({
        params: { id: "01APPEAL1234" },
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/appeals/01APPEAL1234/resolve`, {
            decision: "deny", resolver: "admin1", notes: "Insufficient evidence",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.state, "denied");
    assert.equal(j.attendance_inserted, false);
});

test("appeal resolve: already resolved → 409", async () => {
    const db = auditDB({
        "FROM appeals WHERE id": () => ({
            id: "01APPEAL1234", user_id: "01U", claimed_stream_id: "01S", state: "granted",
        }),
    });
    const r = await resolvePost({
        params: { id: "01APPEAL1234" },
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/appeals/01APPEAL1234/resolve`, {
            decision: "deny", resolver: "admin1",
        }),
    });
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.error, "appeal_not_open");
});

// ── user certs ──────────────────────────────────────────────────────────

test("user certs: unauthorized → 401", async () => {
    const r = await userCertsGet({
        params: { id: "01USERIDTEST" },
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/user/01USERIDTEST/certs`),
    });
    assert.equal(r.status, 401);
});

test("user certs: invalid user id → 400", async () => {
    const r = await userCertsGet({
        params: { id: "short" },
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/user/short/certs`),
    });
    assert.equal(r.status, 400);
});

test("user certs: valid → 200 with certs array", async () => {
    const db = stubDB({
        "FROM certs": () => [
            { id: "01C", public_token: "abc123", period_yyyymm: "202604",
              cert_kind: "bundled", state: "generated", cpe_total: 2 },
        ],
    });
    const r = await userCertsGet({
        params: { id: "01USERIDTEST" },
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/user/01USERIDTEST/certs`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.count, 1);
    assert.equal(j.user_id, "01USERIDTEST");
});

// ── attendance ──────────────────────────────────────────────────────────

test("attendance: unauthorized → 401", async () => {
    const r = await attendancePost({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/attendance`, { method: "POST" }),
    });
    assert.equal(r.status, 401);
});

test("attendance: missing fields → 400", async () => {
    const r = await attendancePost({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/attendance`, {
            user_id: "01USERID1234",
        }),
    });
    assert.equal(r.status, 400);
});

test("attendance: user not found → 404", async () => {
    const db = auditDB({
        "FROM users WHERE id": () => null,
    });
    const r = await attendancePost({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/attendance`, {
            user_id: "01USERID1234",
            stream_id: "01STREAMID12",
            reason: "Poller was down",
            resolver: "admin1",
            rule_version: 1,
        }),
    });
    assert.equal(r.status, 404);
});

test("attendance: duplicate → 409", async () => {
    const db = auditDB({
        "FROM users WHERE id": () => ({ id: "01USERID1234", state: "active", deleted_at: null }),
        "FROM streams WHERE id": () => ({ id: "01STREAMID12", actual_start_at: "2026-04-22T14:00:00Z" }),
        "FROM attendance WHERE user_id": () => ({ source: "poller", created_at: "2026-04-22T14:30:00Z" }),
        "FROM kv WHERE k LIKE": () => [],
    });
    const r = await attendancePost({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/attendance`, {
            user_id: "01USERID1234",
            stream_id: "01STREAMID12",
            reason: "Testing",
            resolver: "admin1",
            rule_version: 1,
        }),
    });
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.error, "attendance_already_recorded");
});

test("attendance: valid grant → 200", async () => {
    const db = auditDB({
        "FROM users WHERE id": () => ({ id: "01USERID1234", state: "active", deleted_at: null }),
        "FROM streams WHERE id": () => ({ id: "01STREAMID12", actual_start_at: "2026-04-22T14:00:00Z" }),
        "FROM attendance WHERE user_id": () => null,
        "INSERT INTO attendance": () => null,
        "FROM kv WHERE k LIKE": () => [],
    });
    const r = await attendancePost({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/attendance`, {
            user_id: "01USERID1234",
            stream_id: "01STREAMID12",
            reason: "Poller was down during this stream",
            resolver: "admin1",
            rule_version: 1,
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.source, "admin_manual");
});

// ── revoke ──────────────────────────────────────────────────────────────

test("revoke: unauthorized → 401", async () => {
    const r = await revokePost({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/revoke`, { method: "POST" }),
    });
    assert.equal(r.status, 401);
});

test("revoke: invalid token → 400", async () => {
    const r = await revokePost({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/revoke`, {
            public_token: "short",
            reason: "test",
        }),
    });
    assert.equal(r.status, 400);
});

test("revoke: cert not found → 404", async () => {
    const db = auditDB({
        "FROM certs WHERE public_token": () => null,
    });
    const r = await revokePost({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/revoke`, {
            public_token: "a".repeat(64),
            reason: "Fraudulent claim",
        }),
    });
    assert.equal(r.status, 404);
});

test("revoke: already revoked → 200 idempotent", async () => {
    const db = auditDB({
        "FROM certs WHERE public_token": () => ({
            id: "01C", state: "revoked", revoked_at: "2026-04-22T00:00:00Z",
            revocation_reason: "prior", user_id: "01U", period_yyyymm: "202604",
        }),
    });
    const r = await revokePost({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/revoke`, {
            public_token: "a".repeat(64),
            reason: "Duplicate revoke",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.already_revoked, true);
});

test("revoke: valid → 200 with cert_id and revoked_at", async () => {
    const db = auditDB({
        "FROM certs WHERE public_token": () => ({
            id: "01C", state: "generated", revoked_at: null,
            revocation_reason: null, user_id: "01U", period_yyyymm: "202604",
        }),
        "UPDATE certs": () => null,
    });
    const r = await revokePost({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/revoke`, {
            public_token: "a".repeat(64),
            reason: "Certificate issued in error",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(j.cert_id);
    assert.ok(j.revoked_at);
});
