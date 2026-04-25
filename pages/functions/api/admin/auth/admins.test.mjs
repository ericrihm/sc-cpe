import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet, onRequestPost, onRequestDelete } from "./admins.js";

const BASE = "https://sc-cpe-web.pages.dev";

function mkKV() {
    const store = new Map();
    return {
        get: async (k) => store.get(k) ?? null,
        put: async (k, v, opts) => store.set(k, v),
        delete: async (k) => store.delete(k),
    };
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

function authReq(url, opts = {}) {
    return new Request(url, {
        ...opts,
        headers: { Authorization: "Bearer adm", ...(opts.headers || {}) },
    });
}

function postAuth(url, body) {
    return authReq(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

function deleteAuth(url, body) {
    return authReq(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

// ── GET list ──────────────────────────────────────────────────────────

test("admins GET: unauthorized → 401", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: new Request(`${BASE}/api/admin/auth/admins`),
    });
    assert.equal(r.status, 401);
});

test("admins GET: returns admin list with passkey counts", async () => {
    const db = stubDB({
        "FROM admin_users ORDER": () => [
            { id: 1, email: "admin@test.com", role: "owner", display_name: null, created_at: "2026-04-24" },
        ],
        "FROM admin_passkeys GROUP BY": () => [
            { admin_id: 1, count: 2 },
        ],
    });
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: authReq(`${BASE}/api/admin/auth/admins`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.admins.length, 1);
    assert.equal(j.admins[0].passkey_count, 2);
    assert.equal(j.your_role, "owner");
});

// ── POST invite ───────────────────────────────────────────────────────

test("admins POST: unauthorized → 401", async () => {
    const r = await onRequestPost({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: new Request(`${BASE}/api/admin/auth/admins`, { method: "POST" }),
    });
    assert.equal(r.status, 401);
});

test("admins POST: bearer (owner role) succeeds at role check", async () => {
    const db = auditDB({
        "INSERT INTO admin_users": () => null,
        "SELECT id, email, role FROM admin_users": () => ({ id: 5, email: "new@test.com", role: "admin" }),
    });
    const r = await onRequestPost({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/auth/admins`, { email: "new@test.com", role: "admin" }),
    });
    assert.equal(r.status, 200);
});

test("admins POST: invalid email → 400", async () => {
    const r = await onRequestPost({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/auth/admins`, { email: "notanemail" }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_email");
});

test("admins POST: invalid role → 400", async () => {
    const r = await onRequestPost({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/auth/admins`, { email: "new@test.com", role: "superadmin" }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_role");
});

test("admins POST: duplicate email → 409", async () => {
    const db = auditDB({
        "SELECT id FROM admin_users WHERE lower": () => ({ id: 1 }),
    });
    const r = await onRequestPost({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/auth/admins`, { email: "existing@test.com" }),
    });
    assert.equal(r.status, 409);
});

test("admins POST: valid invite → 200", async () => {
    const db = auditDB({
        "INSERT INTO admin_users": () => null,
        "SELECT id, email, role FROM admin_users": () => ({ id: 5, email: "new@test.com", role: "admin" }),
    });
    const r = await onRequestPost({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: postAuth(`${BASE}/api/admin/auth/admins`, { email: "new@test.com", role: "admin" }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.admin.email, "new@test.com");
    assert.equal(j.admin.role, "admin");
});

// ── DELETE ─────────────────────────────────────────────────────────────

test("admins DELETE: unauthorized → 401", async () => {
    const r = await onRequestDelete({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: new Request(`${BASE}/api/admin/auth/admins`, { method: "DELETE" }),
    });
    assert.equal(r.status, 401);
});

test("admins DELETE: missing admin_id → 400", async () => {
    const r = await onRequestDelete({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: deleteAuth(`${BASE}/api/admin/auth/admins`, {}),
    });
    assert.equal(r.status, 400);
});

test("admins DELETE: self-remove → 400", async () => {
    const r = await onRequestDelete({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: deleteAuth(`${BASE}/api/admin/auth/admins`, { admin_id: 0 }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "cannot_remove_self");
});

test("admins DELETE: not found → 404", async () => {
    const r = await onRequestDelete({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: deleteAuth(`${BASE}/api/admin/auth/admins`, { admin_id: 999 }),
    });
    assert.equal(r.status, 404);
});

test("admins DELETE: valid → 200", async () => {
    const db = auditDB({
        "SELECT id, email, role FROM admin_users WHERE id": () => ({ id: 5, email: "other@test.com", role: "admin" }),
        "DELETE FROM admin_passkeys": () => null,
        "DELETE FROM admin_users": () => null,
    });
    const r = await onRequestDelete({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: deleteAuth(`${BASE}/api/admin/auth/admins`, { admin_id: 5 }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
});
