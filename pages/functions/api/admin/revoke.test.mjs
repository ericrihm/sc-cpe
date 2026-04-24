import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestPost } from "./revoke.js";

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

test("revoke: unauthorized → 401", async () => {
    const r = await onRequestPost({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/revoke`, { method: "POST" }),
    });
    assert.equal(r.status, 401);
});

test("revoke: missing/short token → 400", async () => {
    const r = await onRequestPost({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/revoke`, {
            public_token: "short", reason: "test",
        }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_public_token");
});

test("revoke: missing reason → 400", async () => {
    const token = "a".repeat(64);
    const r = await onRequestPost({
        env: { DB: auditDB(), ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/revoke`, {
            public_token: token,
        }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "reason_required_under_500_chars");
});

test("revoke: cert not found → 404", async () => {
    const token = "a".repeat(64);
    const db = auditDB({ "FROM certs WHERE public_token": () => null });
    const r = await onRequestPost({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/revoke`, {
            public_token: token, reason: "Policy violation",
        }),
    });
    assert.equal(r.status, 404);
});

test("revoke: already revoked → 200 with already_revoked", async () => {
    const token = "a".repeat(64);
    const db = auditDB({
        "FROM certs WHERE public_token": () => ({
            id: "01C", state: "revoked", revoked_at: "2026-04-20T00:00:00Z",
            revocation_reason: "prior", user_id: "01U", period_yyyymm: "202604",
        }),
    });
    const r = await onRequestPost({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/revoke`, {
            public_token: token, reason: "Duplicate revoke",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.already_revoked, true);
    assert.ok(j.revoked_at);
});

test("revoke: valid → 200 with cert_id and revoked_at", async () => {
    const token = "a".repeat(64);
    const db = auditDB({
        "FROM certs WHERE public_token": () => ({
            id: "01CERT123", state: "delivered", revoked_at: null,
            revocation_reason: null, user_id: "01U", period_yyyymm: "202604",
        }),
        "UPDATE certs": () => null,
    });
    const r = await onRequestPost({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/revoke`, {
            public_token: token, reason: "Fraud detected",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.cert_id, "01CERT123");
    assert.ok(j.revoked_at);
    assert.equal(j.revocation_reason, "Fraud detected");
});
