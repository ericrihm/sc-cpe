import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet, onRequestDelete } from "./passkeys.js";

const BASE = "https://sc-cpe-web.pages.dev";

function mkKV() {
    const store = new Map();
    return {
        get: async (k) => store.get(k) ?? null,
        put: async (k, v) => store.set(k, v),
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

// ── GET ───────────────────────────────────────────────────────────────

test("passkeys GET: unauthorized → 401", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: new Request(`${BASE}/api/admin/auth/passkeys`),
    });
    assert.equal(r.status, 401);
});

test("passkeys GET: returns passkey list", async () => {
    const db = stubDB({
        "FROM admin_passkeys WHERE admin_id": () => [
            { id: "PK1", credential_id: "abcdef1234567890xyz", backed_up: 1, created_at: "2026-04-24", last_used_at: null },
        ],
    });
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: authReq(`${BASE}/api/admin/auth/passkeys`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.passkeys.length, 1);
    assert.equal(j.passkeys[0].backed_up, true);
    assert.equal(j.passkeys[0].credential_id_prefix, "abcdef1234567890");
});

test("passkeys GET: empty → empty array", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: authReq(`${BASE}/api/admin/auth/passkeys`),
    });
    const j = await r.json();
    assert.deepEqual(j.passkeys, []);
});

// ── DELETE ─────────────────────────────────────────────────────────────

test("passkeys DELETE: unauthorized → 401", async () => {
    const r = await onRequestDelete({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: new Request(`${BASE}/api/admin/auth/passkeys`, { method: "DELETE" }),
    });
    assert.equal(r.status, 401);
});

test("passkeys DELETE: missing passkey_id → 400", async () => {
    const r = await onRequestDelete({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: authReq(`${BASE}/api/admin/auth/passkeys`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        }),
    });
    assert.equal(r.status, 400);
});

test("passkeys DELETE: not found → 404", async () => {
    const r = await onRequestDelete({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: authReq(`${BASE}/api/admin/auth/passkeys`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ passkey_id: "NOTFOUND" }),
        }),
    });
    assert.equal(r.status, 404);
});

test("passkeys DELETE: valid → 200", async () => {
    const db = auditDB({
        "FROM admin_passkeys WHERE id": () => ({ id: "PK1", credential_id: "abcdef1234567890xyz" }),
        "DELETE FROM admin_passkeys": () => null,
    });
    const r = await onRequestDelete({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: authReq(`${BASE}/api/admin/auth/passkeys`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ passkey_id: "PK1" }),
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
});
