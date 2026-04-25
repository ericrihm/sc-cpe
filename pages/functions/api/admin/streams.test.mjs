import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet } from "./streams.js";

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

function mkKV() {
    const store = new Map();
    return {
        get: async (k) => store.get(k) ?? null,
        put: async (k, v) => store.set(k, v),
        delete: async (k) => store.delete(k),
    };
}

test("streams: unauthorized → 401", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: new Request(`${BASE}/api/admin/streams`),
    });
    assert.equal(r.status, 401);
});

test("streams: no params → 200 with default 30 days", async () => {
    let capturedBinds = [];
    const db = {
        prepare(sql) {
            return {
                bind(...args) { capturedBinds = args; return this; },
                all: async () => ({ results: [
                    { id: "01S", yt_video_id: "abc", title: "DTB", scheduled_date: "2026-04-24",
                      state: "ended", actual_start_at: "2026-04-24T14:00:00Z",
                      actual_end_at: "2026-04-24T15:00:00Z", attendance_count: 12 },
                ] }),
            };
        },
    };
    const r = await onRequestGet({
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: auth(`${BASE}/api/admin/streams`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.streams.length, 1);
    assert.equal(j.streams[0].attendance_count, 12);
    assert.equal(capturedBinds[0], 30);
});

test("streams: custom days param", async () => {
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
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: auth(`${BASE}/api/admin/streams?days=90`),
    });
    assert.equal(r.status, 200);
    assert.equal(capturedBinds[0], 90);
});

test("streams: invalid days → defaults to 30", async () => {
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
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: auth(`${BASE}/api/admin/streams?days=-5`),
    });
    assert.equal(r.status, 200);
    assert.equal(capturedBinds[0], 30);
});

test("streams: days > 365 → clamped to 30", async () => {
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
        env: { DB: db, ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: auth(`${BASE}/api/admin/streams?days=999`),
    });
    assert.equal(r.status, 200);
    assert.equal(capturedBinds[0], 30);
});

test("streams: empty result → empty array", async () => {
    const r = await onRequestGet({
        env: { DB: stubDB(), ADMIN_TOKEN: "adm", RATE_KV: mkKV() },
        request: auth(`${BASE}/api/admin/streams`),
    });
    const j = await r.json();
    assert.deepEqual(j.streams, []);
});
