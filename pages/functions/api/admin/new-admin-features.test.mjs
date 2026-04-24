import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestPost as suspendPost } from "./suspend.js";
import { onRequestGet as suppressionGet, onRequestDelete as suppressionDelete } from "./email-suppression.js";
import { onRequestGet as streamsGet } from "./streams.js";

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

function deleteAuth(url, body) {
    return auth(url, {
        method: "DELETE",
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

// ── suspend ─────────────────────────────────────────────────────────────

test("suspend: unauthorized → 401", async () => {
    const r = await suspendPost({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/suspend`, { method: "POST" }),
    });
    assert.equal(r.status, 401);
});

test("suspend: missing fields → 400", async () => {
    const r = await suspendPost({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/suspend`, { user_id: "01U" }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "reason_required_under_500_chars");
});

test("suspend: user not found → 404", async () => {
    const db = auditDB({
        "FROM users WHERE id": () => null,
    });
    const r = await suspendPost({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/suspend`, {
            user_id: "01NOTEXIST12345",
            suspended: true,
            reason: "Policy violation",
        }),
    });
    assert.equal(r.status, 404);
});

test("suspend: valid suspend → 200", async () => {
    const db = auditDB({
        "FROM users WHERE id": () => ({
            id: "01USERID1234", state: "active", suspended_at: null,
        }),
        "UPDATE users SET suspended_at": () => null,
    });
    const r = await suspendPost({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/suspend`, {
            user_id: "01USERID1234",
            suspended: true,
            reason: "Policy violation",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(j.suspended_at);
});

test("suspend: valid unsuspend → 200", async () => {
    const db = auditDB({
        "FROM users WHERE id": () => ({
            id: "01USERID1234", state: "active", suspended_at: "2026-04-22T00:00:00Z",
        }),
        "UPDATE users SET suspended_at": () => null,
    });
    const r = await suspendPost({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/suspend`, {
            user_id: "01USERID1234",
            suspended: false,
            reason: "Appeal granted",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.suspended_at, null);
});

// ── email-suppression GET ───────────────────────────────────────────────

test("email-suppression GET: unauthorized → 401", async () => {
    const r = await suppressionGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/email-suppression`),
    });
    assert.equal(r.status, 401);
});

test("email-suppression GET: valid → 200 with suppressions", async () => {
    const db = stubDB({
        "FROM email_suppression": () => [
            { email: "test@example.com", reason: "hard_bounce", event_id: "evt_1", created_at: "2026-04-22T00:00:00Z" },
        ],
    });
    const r = await suppressionGet({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: auth(`${BASE}/api/admin/email-suppression`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.suppressions));
    assert.equal(j.suppressions.length, 1);
    assert.ok(j.suppressions[0].email_masked.includes("***"));
});

// ── email-suppression DELETE ────────────────────────────────────────────

test("email-suppression DELETE: unauthorized → 401", async () => {
    const r = await suppressionDelete({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/email-suppression`, { method: "DELETE" }),
    });
    assert.equal(r.status, 401);
});

test("email-suppression DELETE: not found → 404", async () => {
    const db = auditDB({
        "FROM email_suppression WHERE email": () => null,
    });
    const r = await suppressionDelete({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: deleteAuth(`${BASE}/api/admin/email-suppression`, {
            email: "nobody@example.com",
        }),
    });
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.equal(j.error, "not_found");
});

test("email-suppression DELETE: valid → 200", async () => {
    const db = auditDB({
        "FROM email_suppression WHERE email": () => ({ email: "test@example.com" }),
        "DELETE FROM email_suppression": () => null,
    });
    const r = await suppressionDelete({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: deleteAuth(`${BASE}/api/admin/email-suppression`, {
            email: "test@example.com",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
});

// ── streams ─────────────────────────────────────────────────────────────

test("streams: unauthorized → 401", async () => {
    const r = await streamsGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/streams`),
    });
    assert.equal(r.status, 401);
});

test("streams: valid → 200 with streams array", async () => {
    const db = stubDB({
        "FROM streams": () => [
            { id: "01S", yt_video_id: "abc123", title: "Daily Threat Briefing",
              scheduled_date: "2026-04-22", state: "ended",
              actual_start_at: "2026-04-22T14:00:00Z", actual_end_at: "2026-04-22T15:00:00Z",
              attendance_count: 42 },
        ],
    });
    const r = await streamsGet({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: auth(`${BASE}/api/admin/streams?days=7`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.streams));
    assert.equal(j.streams[0].attendance_count, 42);
});
