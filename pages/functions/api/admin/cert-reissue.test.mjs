import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestPost } from "./cert/[id]/reissue.js";

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

test("cert reissue: unauthorized → 401", async () => {
    const r = await onRequestPost({
        params: { id: "01CERTID0000000" },
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/cert/01CERTID0000000/reissue`, { method: "POST" }),
    });
    assert.equal(r.status, 401);
});

test("cert reissue: cert not found → 404", async () => {
    const db = auditDB({ "FROM certs WHERE id": () => null });
    const r = await onRequestPost({
        params: { id: "01NOTEXIST12345" },
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/cert/01NOTEXIST12345/reissue`, {
            reason: "Name correction",
        }),
    });
    assert.equal(r.status, 404);
});

test("cert reissue: missing reason → 400", async () => {
    const db = auditDB({
        "FROM certs WHERE id": () => ({
            id: "01C", user_id: "01U", state: "delivered",
            period_yyyymm: "202604", cert_kind: "bundled",
        }),
    });
    const r = await onRequestPost({
        params: { id: "01C0000000000000" },
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/cert/01C0000000000000/reissue`, {}),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "reason_required_under_500_chars");
});

test("cert reissue: revoked cert → 409", async () => {
    const db = auditDB({
        "FROM certs WHERE id": () => ({
            id: "01C", user_id: "01U", state: "revoked",
            period_yyyymm: "202604", cert_kind: "bundled",
        }),
    });
    const r = await onRequestPost({
        params: { id: "01C0000000000000" },
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/cert/01C0000000000000/reissue`, {
            reason: "Name correction",
        }),
    });
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.error, "cannot_reissue_revoked");
});

test("cert reissue: already pending reissue → 200 with reissued false", async () => {
    const db = auditDB({
        "FROM certs WHERE id": () => ({
            id: "01C", user_id: "01U", state: "delivered",
            period_yyyymm: "202604", cert_kind: "bundled",
        }),
        "supersedes_cert_id.*pending": () => ({
            id: "01PENDING", state: "pending",
        }),
    });
    const r = await onRequestPost({
        params: { id: "01C0000000000000" },
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/cert/01C0000000000000/reissue`, {
            reason: "Name correction",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.reissued, false);
    assert.equal(j.pending_cert_id, "01PENDING");
});

test("cert reissue: valid → 200 with new pending cert", async () => {
    const db = auditDB({
        "FROM certs WHERE id": () => ({
            id: "01C", user_id: "01U", state: "delivered",
            period_yyyymm: "202604", period_start: "2026-04-01",
            period_end: "2026-04-30", cert_kind: "bundled",
            stream_id: null, cpe_total: 5.0, sessions_count: 10,
            session_video_ids: "vid1,vid2",
        }),
        "supersedes_cert_id.*pending": () => null,
        "UPDATE certs SET state": () => null,
        "INSERT INTO certs": () => null,
    });
    const r = await onRequestPost({
        params: { id: "01C0000000000000" },
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: postAuth(`${BASE}/api/admin/cert/01C0000000000000/reissue`, {
            reason: "Name correction",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.reissued, true);
    assert.ok(j.pending_cert_id);
    assert.equal(j.supersedes_cert_id, "01C");
});
