// Tests for /api/admin/toggles (GET list + POST set/clear). These are the
// break-glass kill switches for register/recover/preflight. Only critical
// public endpoints are killable; dashboard reads + verify + download must
// stay on even under kill — those are NOT in KILL_SWITCHES.

import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet as togglesGet, onRequestPost as togglePost } from "./toggles.js";
import { KILL_SWITCHES } from "../../_lib.js";

const BASE = "https://sc-cpe-web.pages.dev/api/admin/toggles";

function mkKV(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        get: async (k) => store.get(k) ?? null,
        put: async (k, v) => { store.set(k, v); },
        delete: async (k) => { store.delete(k); },
        _snapshot: () => Object.fromEntries(store.entries()),
    };
}

function auth(body) {
    const init = { method: body ? "POST" : "GET", headers: { Authorization: "Bearer adm" } };
    if (body) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
    }
    return new Request(BASE, init);
}

const DB_OK = {
    prepare() {
        return {
            bind: () => ({ first: async () => null, run: async () => ({ meta: {} }) }),
            first: async () => null,
            run: async () => ({ meta: {} }),
        };
    },
};

test("toggles GET: lists every KILL_SWITCH with killed:false when KV empty", async () => {
    const kv = mkKV();
    const r = await togglesGet({ env: { DB: DB_OK, RATE_KV: kv, ADMIN_TOKEN: "adm" }, request: auth() });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.toggles.length, KILL_SWITCHES.length);
    for (const t of j.toggles) {
        assert.equal(t.killed, false);
        assert.ok(KILL_SWITCHES.includes(t.name));
    }
});

test("toggles GET: kill:register set in KV → that toggle reports killed:true", async () => {
    const kv = mkKV({ "kill:register": "1" });
    const r = await togglesGet({ env: { DB: DB_OK, RATE_KV: kv, ADMIN_TOKEN: "adm" }, request: auth() });
    const j = await r.json();
    const reg = j.toggles.find(t => t.name === "register");
    assert.equal(reg.killed, true);
    const recover = j.toggles.find(t => t.name === "recover");
    assert.equal(recover.killed, false);
});

test("toggles POST: sets kill:<name>=1 when killed:true", async () => {
    const kv = mkKV();
    const r = await togglePost({
        env: { DB: DB_OK, RATE_KV: kv, ADMIN_TOKEN: "adm" },
        request: auth({ name: "preflight", killed: true }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.killed, true);
    assert.equal(kv._snapshot()["kill:preflight"], "1");
});

test("toggles POST: deletes kill:<name> when killed:false", async () => {
    const kv = mkKV({ "kill:register": "1" });
    const r = await togglePost({
        env: { DB: DB_OK, RATE_KV: kv, ADMIN_TOKEN: "adm" },
        request: auth({ name: "register", killed: false }),
    });
    assert.equal(r.status, 200);
    assert.equal(kv._snapshot()["kill:register"], undefined);
});

test("toggles POST: unknown switch name → 400", async () => {
    const kv = mkKV();
    const r = await togglePost({
        env: { DB: DB_OK, RATE_KV: kv, ADMIN_TOKEN: "adm" },
        request: auth({ name: "nuke_everything", killed: true }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "unknown_switch");
    assert.deepEqual(j.known, KILL_SWITCHES);
});

test("toggles POST: unauthorized without bearer → 401", async () => {
    const kv = mkKV();
    const r = await togglePost({
        env: { DB: DB_OK, RATE_KV: kv, ADMIN_TOKEN: "adm" },
        request: new Request(BASE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "register", killed: true }),
        }),
    });
    assert.equal(r.status, 401);
});
