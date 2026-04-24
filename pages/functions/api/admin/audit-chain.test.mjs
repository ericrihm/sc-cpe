import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet } from "./audit-chain-verify.js";

const BASE = "https://sc-cpe-web.pages.dev";

function auth(url) {
    return new Request(url, {
        headers: { Authorization: "Bearer adm" },
    });
}

function stubDB(overrides = {}) {
    return {
        prepare(sql) {
            const handler = Object.entries(overrides).find(([pattern]) =>
                new RegExp(pattern, "is").test(sql)
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

test("audit-chain-verify: unauthorized → 401", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/audit-chain-verify`),
    });
    assert.equal(r.status, 401);
});

test("audit-chain-verify: empty table → ok with 0 rows", async () => {
    const db = stubDB({
        "sqlite_master.*LIKE": () => ({ name: "audit_prev_hash_unique" }),
        "sqlite_master.*type = 'index'": () => [
            { name: "audit_prev_hash_unique", sql: "CREATE UNIQUE INDEX audit_prev_hash_unique ON audit_log(prev_hash)" },
        ],
        "FROM audit_log.*ORDER": () => [],
        "COUNT.*FROM audit_log": () => ({ n: 0 }),
    });
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/audit-chain-verify`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.rows_checked, 0);
    assert.equal(j.first_break, null);
});

test("audit-chain-verify: missing unique index → unique_index false", async () => {
    const db = stubDB({
        "sqlite_master.*LIKE": () => null,
        "sqlite_master.*type = 'index'": () => [],
        "FROM audit_log.*ORDER": () => [],
        "COUNT.*FROM audit_log": () => ({ n: 0 }),
    });
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/audit-chain-verify`),
    });
    const j = await r.json();
    assert.equal(j.unique_index_on_prev_hash, false);
    assert.ok(j.index_warning);
});

test("audit-chain-verify: valid chain with unique index → ok true", async () => {
    const db = stubDB({
        "sqlite_master.*LIKE": () => ({ name: "audit_prev_hash_unique" }),
        "sqlite_master.*type = 'index'": () => [
            { name: "audit_prev_hash_unique", sql: "CREATE UNIQUE INDEX audit_prev_hash_unique ON audit_log(prev_hash)" },
        ],
        "FROM audit_log.*ORDER": () => [
            { id: "01A", actor_type: "system", actor_id: null, action: "genesis", entity_type: "system", entity_id: "init", before_json: null, after_json: null, ip_hash: null, user_agent: null, ts: "2026-01-01T00:00:00Z", prev_hash: null },
        ],
        "COUNT.*FROM audit_log": () => ({ n: 1 }),
    });
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/audit-chain-verify?limit=50`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.rows_checked, 1);
    assert.equal(j.first_break, null);
    assert.equal(j.unique_index_on_prev_hash, true);
});

test("audit-chain-verify: limit param clamped", async () => {
    const db = stubDB({
        "sqlite_master.*LIKE": () => ({ name: "audit_prev_hash_unique" }),
        "sqlite_master.*type = 'index'": () => [
            { name: "audit_prev_hash_unique", sql: "CREATE UNIQUE INDEX audit_prev_hash_unique ON audit_log(prev_hash)" },
        ],
        "FROM audit_log.*ORDER": (sql, binds) => {
            assert.ok(binds[0] <= 50000);
            return [];
        },
        "COUNT.*FROM audit_log": () => ({ n: 0 }),
    });
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: auth(`${BASE}/api/admin/audit-chain-verify?limit=999999`),
    });
    assert.equal(r.status, 200);
});
