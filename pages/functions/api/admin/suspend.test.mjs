import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestPost } from "./suspend.js";

const BASE = "https://sc-cpe-web.pages.dev";

function postAuth(url, body) {
    return new Request(url, {
        method: "POST",
        headers: { Authorization: "Bearer adm", "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

function stubDB(overrides = {}) {
    const noop = { meta: {} };
    return {
        prepare(sql) {
            const handler = Object.entries(overrides).find(([p]) =>
                new RegExp(p, "i").test(sql)
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
            id: "01X", ts: "2026-04-24T00:00:00Z", prev_hash: "abc",
        }),
    });
}

function mkKV() {
    const store = new Map();
    return {
        get: async (k) => store.get(k) ?? null,
        put: async (k, v) => store.set(k, v),
        delete: async (k) => store.delete(k),
    };
}

test("suspend: unauthorized → 401", async () => {
    const r = await onRequestPost({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: new Request(`${BASE}/api/admin/suspend`, { method: "POST" }),
    });
    assert.equal(r.status, 401);
});

test("suspend: missing user_id → 400", async () => {
    const r = await onRequestPost({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/suspend`, { suspended: true, reason: "test" }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_user_id");
});

test("suspend: missing reason → 400", async () => {
    const r = await onRequestPost({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/suspend`, { user_id: "01USERID1234", suspended: true }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "reason_required_under_500_chars");
});

test("suspend: user not found → 404", async () => {
    const r = await onRequestPost({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/suspend`, {
            user_id: "01NOTFOUND12", suspended: true, reason: "Abuse",
        }),
    });
    assert.equal(r.status, 404);
});

test("suspend: valid suspension → 200", async () => {
    const db = auditDB({
        "FROM users WHERE id": () => ({ id: "01USERID1234", state: "active", suspended_at: null }),
        "UPDATE users SET suspended_at": () => null,
    });
    const r = await onRequestPost({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/suspend`, {
            user_id: "01USERID1234", suspended: true, reason: "Abuse detected",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.user_id, "01USERID1234");
    assert.ok(j.suspended_at);
});

test("suspend: unsuspend → 200 with null suspended_at", async () => {
    const db = auditDB({
        "FROM users WHERE id": () => ({ id: "01USERID1234", state: "active", suspended_at: "2026-04-20T00:00:00Z" }),
        "UPDATE users SET suspended_at": () => null,
    });
    const r = await onRequestPost({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/suspend`, {
            user_id: "01USERID1234", suspended: false, reason: "Appeal resolved",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.suspended_at, null);
});
