import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet as appealsGet } from "./appeals.js";
import { onRequestPost as resolvePost } from "./appeals/[id]/resolve.js";

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

function auditDB(overrides = {}) {
    return stubDB({
        ...overrides,
        "INSERT INTO audit_log": () => null,
        "SELECT id, ts, prev_hash FROM audit_log ORDER BY ts DESC": () => ({
            id: "01X", ts: "2026-04-22T00:00:00Z", prev_hash: "abc",
        }),
    });
}

function mkKV() {
    const store = new Map();
    return {
        get: async (k) => store.get(k) ?? null,
        put: async (k, v) => { store.set(k, v); },
        delete: async (k) => { store.delete(k); },
    };
}

// ── GET appeals ────────────────────────────────────────────────────────

test("appeals GET: unauthorized → 401", async () => {
    const r = await appealsGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/appeals`),
    });
    assert.equal(r.status, 401);
});

test("appeals GET: valid → 200 with appeals array", async () => {
    const db = stubDB({
        "FROM appeals": () => [
            { id: "01A", user_id: "01U", claimed_date: "2026-04-20", state: "open",
              email: "a@b.com", legal_name: "Test" },
        ],
    });
    const r = await appealsGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/appeals?state=open`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.appeals));
    assert.equal(j.appeals.length, 1);
});

test("appeals GET: invalid state → 400", async () => {
    const r = await appealsGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/appeals?state=bogus`),
    });
    assert.equal(r.status, 400);
});

// ── POST resolve ───────────────────────────────────────────────────────

test("appeals resolve: unauthorized → 401", async () => {
    const r = await resolvePost({
        params: { id: "01APPEALID12345" },
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/appeals/01APPEALID12345/resolve`, { method: "POST" }),
    });
    assert.equal(r.status, 401);
});

test("appeals resolve: appeal not found → 404", async () => {
    const db = auditDB({ "FROM appeals WHERE id": () => null });
    const r = await resolvePost({
        params: { id: "01NOTEXIST12345" },
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/appeals/01NOTEXIST12345/resolve`, {
            decision: "deny", resolver: "admin1", notes: "no evidence",
        }),
    });
    assert.equal(r.status, 404);
});

test("appeals resolve: already resolved → 409", async () => {
    const db = auditDB({
        "FROM appeals WHERE id": () => ({
            id: "01A", user_id: "01U", claimed_stream_id: "01S", state: "granted",
        }),
    });
    const r = await resolvePost({
        params: { id: "01A0000000000000" },
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/appeals/01A0000000000000/resolve`, {
            decision: "deny", resolver: "admin1",
        }),
    });
    assert.equal(r.status, 409);
});

test("appeals resolve deny: valid → 200", async () => {
    const db = auditDB({
        "FROM appeals WHERE id": () => ({
            id: "01A", user_id: "01U", claimed_stream_id: "01S", state: "open",
        }),
        "UPDATE appeals": () => null,
        "FROM users WHERE id": () => ({
            email: "test@invalid", legal_name: "Test", dashboard_token: "tok",
        }),
        "INSERT INTO email_outbox": () => null,
    });
    const r = await resolvePost({
        params: { id: "01A0000000000000" },
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/appeals/01A0000000000000/resolve`, {
            decision: "deny", resolver: "admin1", notes: "insufficient evidence",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.state, "denied");
    assert.equal(j.attendance_inserted, false);
});

test("appeals resolve grant: valid → 200 with attendance", async () => {
    const db = auditDB({
        "FROM appeals WHERE id": () => ({
            id: "01A", user_id: "01U", claimed_stream_id: "01S", state: "open",
        }),
        "FROM attendance WHERE user_id": () => null,
        "INSERT INTO attendance": () => null,
        "UPDATE appeals": () => null,
        "rule_version": () => ({ v: "0.5" }),
    });
    const r = await resolvePost({
        params: { id: "01A0000000000000" },
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/appeals/01A0000000000000/resolve`, {
            decision: "grant", resolver: "admin1", rule_version: 1,
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.state, "granted");
    assert.equal(j.attendance_inserted, true);
});
