import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestPost as authOptions } from "./passkey/auth-options.js";
import { onRequestPost as authVerify } from "./passkey/auth-verify.js";

const BASE = "https://sc-cpe-web.pages.dev";

function mkKV() {
    const store = new Map();
    return {
        get: async (k, fmt) => {
            const v = store.get(k) ?? null;
            return fmt === "json" && v ? JSON.parse(v) : v;
        },
        put: async (k, v, opts) => store.set(k, typeof v === "string" ? v : JSON.stringify(v)),
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

test("passkey auth-options: rate limited after 10 requests", async () => {
    const kv = mkKV();
    const env = { RATE_KV: kv, DB: stubDB() };
    for (let i = 0; i < 10; i++) {
        const r = await authOptions({
            request: new Request(`${BASE}/api/admin/auth/passkey/auth-options`, { method: "POST" }),
            env,
        });
        assert.equal(r.status, 200);
    }
    const r = await authOptions({
        request: new Request(`${BASE}/api/admin/auth/passkey/auth-options`, { method: "POST" }),
        env,
    });
    assert.equal(r.status, 429);
});

test("passkey auth-options: returns challenge and rpId", async () => {
    const kv = mkKV();
    const r = await authOptions({
        request: new Request(`${BASE}/api/admin/auth/passkey/auth-options`, { method: "POST" }),
        env: { RATE_KV: kv, DB: stubDB() },
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.challenge);
    assert.equal(j.rpId, "sc-cpe-web.pages.dev");
    assert.equal(j.userVerification, "preferred");
});

test("passkey auth-verify: missing credential → 400", async () => {
    const r = await authVerify({
        request: new Request(`${BASE}/api/admin/auth/passkey/auth-verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        }),
        env: { DB: stubDB(), RATE_KV: mkKV() },
    });
    assert.equal(r.status, 400);
});

test("passkey auth-verify: invalid challenge → 400", async () => {
    const fakeClientData = btoa(JSON.stringify({
        type: "webauthn.get",
        challenge: "nonexistent_challenge",
        origin: BASE,
    })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const r = await authVerify({
        request: new Request(`${BASE}/api/admin/auth/passkey/auth-verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: "cred123",
                response: {
                    clientDataJSON: fakeClientData,
                    authenticatorData: "AAAA",
                    signature: "AAAA",
                },
            }),
        }),
        env: { DB: stubDB(), RATE_KV: mkKV() },
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_challenge");
});
