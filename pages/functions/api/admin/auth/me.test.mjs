import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet } from "./me.js";

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
                run: async () => ({ meta: {} }),
            };
            return stmt;
        },
    };
}

test("me: unauthorized → 401", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: new Request(`${BASE}/api/admin/auth/me`),
    });
    assert.equal(r.status, 401);
});

test("me: returns admin identity and role", async () => {
    const db = stubDB({
        "COUNT.*FROM admin_passkeys": () => ({ count: 3 }),
    });
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: new Request(`${BASE}/api/admin/auth/me`, {
            headers: { Authorization: "Bearer adm" },
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.role, "owner");
    assert.equal(j.email, "__bearer__");
});
