import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet } from "./audit-log.js";

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
            let binds = [];
            const stmt = {
                bind(...args) { binds = args; return stmt; },
                all: async () => handler ? { results: handler[1](sql, binds) } : { results: [] },
            };
            return stmt;
        },
    };
}

test("audit-log: unauthorized → 401", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/audit-log`),
    });
    assert.equal(r.status, 401);
});

test("audit-log: no filters → 200 with rows", async () => {
    const db = stubDB({
        "FROM audit_log": () => [
            { id: "01A", actor_type: "system", actor_id: null, action: "user_registered",
              entity_type: "user", entity_id: "01U", ts: "2026-04-24T10:00:00Z" },
        ],
    });
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/audit-log`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.count, 1);
    assert.equal(j.rows[0].action, "user_registered");
});

test("audit-log: search query filters by action", async () => {
    let capturedBinds = [];
    const db = {
        prepare(sql) {
            return {
                bind(...args) { capturedBinds = args; return this; },
                all: async () => ({ results: [] }),
            };
        },
    };
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/audit-log?q=cert_issued`),
    });
    assert.equal(r.status, 200);
    assert.ok(capturedBinds[0].includes("cert_issued"));
});

test("audit-log: date range filters", async () => {
    let capturedBinds = [];
    const db = {
        prepare(sql) {
            return {
                bind(...args) { capturedBinds = args; return this; },
                all: async () => ({ results: [] }),
            };
        },
    };
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/audit-log?from=2026-04-01&to=2026-04-30`),
    });
    assert.equal(r.status, 200);
    assert.ok(capturedBinds.some(b => b.includes("2026-04-01")));
    assert.ok(capturedBinds.some(b => b.includes("2026-04-30")));
});

test("audit-log: limit capped at 500", async () => {
    let capturedBinds = [];
    const db = {
        prepare(sql) {
            return {
                bind(...args) { capturedBinds = args; return this; },
                all: async () => ({ results: [] }),
            };
        },
    };
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/audit-log?limit=9999`),
    });
    assert.equal(r.status, 200);
    assert.equal(capturedBinds[capturedBinds.length - 1], 500);
});

test("audit-log: empty result → count 0", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/audit-log`),
    });
    const j = await r.json();
    assert.equal(j.count, 0);
    assert.deepEqual(j.rows, []);
});
