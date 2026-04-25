import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet, onRequestDelete } from "./email-suppression.js";

const BASE = "https://sc-cpe-web.pages.dev";

function auth(url, opts = {}) {
    return new Request(url, {
        ...opts,
        headers: { Authorization: "Bearer adm", ...(opts.headers || {}) },
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

// ── GET ────────────────────────────────────────────────────────────────

test("email-suppression GET: unauthorized → 401", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: new Request(`${BASE}/api/admin/email-suppression`),
    });
    assert.equal(r.status, 401);
});

test("email-suppression GET: returns masked emails", async () => {
    const db = stubDB({
        "FROM email_suppression": () => [
            { email: "bob@example.com", reason: "hard_bounce", event_id: "ev1", created_at: "2026-04-24T00:00:00Z" },
        ],
    });
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: auth(`${BASE}/api/admin/email-suppression`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.suppressions.length, 1);
    assert.equal(j.suppressions[0].email_masked, "bob***@example.com");
    assert.equal(j.suppressions[0].reason, "hard_bounce");
});

test("email-suppression GET: empty → empty array", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: auth(`${BASE}/api/admin/email-suppression`),
    });
    const j = await r.json();
    assert.deepEqual(j.suppressions, []);
});

// ── DELETE ─────────────────────────────────────────────────────────────

test("email-suppression DELETE: unauthorized → 401", async () => {
    const r = await onRequestDelete({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/email-suppression`, { method: "DELETE" }),
    });
    assert.equal(r.status, 401);
});

test("email-suppression DELETE: missing email → 400", async () => {
    const r = await onRequestDelete({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm" },
        request: deleteAuth(`${BASE}/api/admin/email-suppression`, {}),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_email");
});

test("email-suppression DELETE: email without @ → 400", async () => {
    const r = await onRequestDelete({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm" },
        request: deleteAuth(`${BASE}/api/admin/email-suppression`, { email: "notanemail" }),
    });
    assert.equal(r.status, 400);
});

test("email-suppression DELETE: not found → 404", async () => {
    const r = await onRequestDelete({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm" },
        request: deleteAuth(`${BASE}/api/admin/email-suppression`, { email: "nobody@example.com" }),
    });
    assert.equal(r.status, 404);
});

test("email-suppression DELETE: valid → 200", async () => {
    const db = auditDB({
        "SELECT email FROM email_suppression": () => ({ email: "bob@example.com" }),
        "DELETE FROM email_suppression": () => null,
    });
    const r = await onRequestDelete({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: deleteAuth(`${BASE}/api/admin/email-suppression`, { email: "bob@example.com" }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
});
