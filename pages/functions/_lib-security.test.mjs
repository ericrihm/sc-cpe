import { test } from "node:test";
import assert from "node:assert/strict";

import { isAdmin, audit, rateLimit, constantTimeEqual, canonicalAuditRow, sha256Hex, classifyRevocation, escapeHtml, killSwitched } from "./_lib.js";

function mkKV() {
    const store = new Map();
    return {
        get: async (k) => store.get(k) ?? null,
        put: async (k, v, opts) => { store.set(k, v); },
        delete: async (k) => { store.delete(k); },
    };
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

// ── isAdmin ───────────────────────────────────────────────────────────

test("isAdmin: missing Authorization header → false", async () => {
    const r = await isAdmin(
        { ADMIN_TOKEN: "secret123" },
        new Request("https://x.dev/api/admin/test"),
    );
    assert.equal(r, false);
});

test("isAdmin: wrong bearer token → false", async () => {
    const r = await isAdmin(
        { ADMIN_TOKEN: "correct_token" },
        new Request("https://x.dev/api/admin/test", {
            headers: { Authorization: "Bearer wrong_token" },
        }),
    );
    assert.equal(r, false);
});

test("isAdmin: correct bearer token → true", async () => {
    const r = await isAdmin(
        { ADMIN_TOKEN: "correct_token" },
        new Request("https://x.dev/api/admin/test", {
            headers: { Authorization: "Bearer correct_token" },
        }),
    );
    assert.equal(r, true);
});

test("isAdmin: case-insensitive 'bearer' prefix → true", async () => {
    const r = await isAdmin(
        { ADMIN_TOKEN: "tok" },
        new Request("https://x.dev/api/admin/test", {
            headers: { Authorization: "bearer tok" },
        }),
    );
    assert.equal(r, true);
});

test("isAdmin: empty ADMIN_TOKEN env → false (never matches)", async () => {
    const r = await isAdmin(
        { ADMIN_TOKEN: "" },
        new Request("https://x.dev/api/admin/test", {
            headers: { Authorization: "Bearer " },
        }),
    );
    assert.equal(r, false);
});

// ── constantTimeEqual ─────────────────────────────────────────────────

test("constantTimeEqual: equal strings → true", async () => {
    assert.equal(await constantTimeEqual("hello", "hello"), true);
});

test("constantTimeEqual: different strings → false", async () => {
    assert.equal(await constantTimeEqual("hello", "world"), false);
});

test("constantTimeEqual: different lengths → false", async () => {
    assert.equal(await constantTimeEqual("short", "longer_string"), false);
});

// ── rateLimit ─────────────────────────────────────────────────────────

test("rateLimit: first call within window → ok: true", async () => {
    const env = { RATE_KV: mkKV() };
    const result = await rateLimit(env, "test_key", 10, 60);
    assert.equal(result.ok, true);
    assert.ok(result.headers);
    assert.equal(result.headers["X-RateLimit-Limit"], "10");
});

test("rateLimit: exceeds max → ok: false with 429", async () => {
    const kv = mkKV();
    const env = { RATE_KV: kv };
    await kv.put("test_key", "10");
    const result = await rateLimit(env, "test_key", 10, 60);
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.body.error, "rate_limited");
    assert.equal(result.headers["Retry-After"], "60");
});

test("rateLimit: missing RATE_KV → ok: false with 503 (fail-closed)", async () => {
    const result = await rateLimit({}, "test_key", 10);
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.body.error, "rate_limiter_unavailable");
});

test("rateLimit: different keys are independent", async () => {
    const env = { RATE_KV: mkKV() };
    await env.RATE_KV.put("key_a", "9");
    const resultA = await rateLimit(env, "key_a", 10, 60);
    assert.equal(resultA.ok, true);
    const resultB = await rateLimit(env, "key_b", 10, 60);
    assert.equal(resultB.ok, true);
    assert.equal(resultB.headers["X-RateLimit-Remaining"], "9");
});

// ── audit ─────────────────────────────────────────────────────────────

test("audit: genesis row (empty table) has prev_hash = null", async () => {
    let insertedBinds = null;
    const db = {
        prepare(sql) {
            const isSelect = /SELECT/.test(sql);
            const stmt = {
                bind(...args) { if (!isSelect) insertedBinds = args; return stmt; },
                first: async () => null,
                run: async () => ({ meta: {} }),
            };
            return stmt;
        },
    };
    await audit({ DB: db }, "system", null, "genesis", "system", "init", null, null);
    assert.ok(insertedBinds, "INSERT should have been called");
    assert.equal(insertedBinds[11], null, "prev_hash should be null for genesis row");
});

test("audit: second row gets prev_hash = sha256(canonical(tip))", async () => {
    const tipRow = {
        id: "01GENESIS",
        actor_type: "system", actor_id: null,
        action: "genesis", entity_type: "system", entity_id: "init",
        before_json: null, after_json: null,
        ip_hash: null, user_agent: null,
        ts: "2026-04-24T00:00:00Z", prev_hash: null,
    };
    const expectedHash = await sha256Hex(canonicalAuditRow(tipRow));

    let insertedBinds = null;
    const db = {
        prepare(sql) {
            const isSelect = /SELECT/.test(sql);
            const stmt = {
                bind(...args) { if (!isSelect) insertedBinds = args; return stmt; },
                first: async () => isSelect ? tipRow : null,
                run: async () => ({ meta: {} }),
            };
            return stmt;
        },
    };
    await audit({ DB: db }, "admin", "a1", "test_action", "user", "u1", null, { x: 1 });
    assert.ok(insertedBinds);
    assert.equal(insertedBinds[11], expectedHash, "prev_hash should match sha256(canonical(tip))");
});

test("audit: ip_hash lands in ip_hash column (bind position 9)", async () => {
    let insertedBinds = null;
    const db = {
        prepare(sql) {
            const isSelect = /SELECT/.test(sql);
            const stmt = {
                bind(...args) { if (!isSelect) insertedBinds = args; return stmt; },
                first: async () => null,
                run: async () => ({ meta: {} }),
            };
            return stmt;
        },
    };
    await audit({ DB: db }, "system", null, "test", "user", "u1", null, null, { ip_hash: "abc123" });
    assert.ok(insertedBinds);
    assert.equal(insertedBinds[8], "abc123", "ip_hash should be in bind position 9 (0-indexed 8)");
});

test("audit: retries on UNIQUE constraint violation", async () => {
    let attempts = 0;
    const db = {
        prepare(sql) {
            const isSelect = /SELECT/.test(sql);
            const stmt = {
                bind(...args) { return stmt; },
                first: async () => null,
                run: async () => {
                    attempts++;
                    if (attempts <= 2) {
                        throw new Error("UNIQUE constraint failed: audit_log.prev_hash");
                    }
                    return { meta: {} };
                },
            };
            return stmt;
        },
    };
    const id = await audit({ DB: db }, "system", null, "test", "system", "init", null, null);
    assert.ok(id, "should return an id after retry");
    assert.equal(attempts, 3, "should have retried twice then succeeded on 3rd");
});

// ── classifyRevocation ────────────────────────────────────────────────

test("classifyRevocation: 'fraud' keyword → issued_in_error", () => {
    assert.equal(classifyRevocation("Suspected fraud"), "issued_in_error");
    assert.equal(classifyRevocation("Impersonation detected"), "issued_in_error");
});

test("classifyRevocation: unknown text → other", () => {
    assert.equal(classifyRevocation("Admin requested removal"), "other");
});

test("classifyRevocation: empty/null → other", () => {
    assert.equal(classifyRevocation(""), "other");
    assert.equal(classifyRevocation(null), "other");
    assert.equal(classifyRevocation(undefined), "other");
});

// ── escapeHtml ────────────────────────────────────────────────────────

test("escapeHtml: escapes dangerous characters", () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'),
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    assert.equal(escapeHtml("it's & fun"), "it&#39;s &amp; fun");
});

test("escapeHtml: preserves safe text", () => {
    assert.equal(escapeHtml("Hello World 123"), "Hello World 123");
});

test("escapeHtml: handles non-string input", () => {
    assert.equal(escapeHtml(42), "42");
    assert.equal(escapeHtml(null), "null");
    assert.equal(escapeHtml(undefined), "undefined");
});

// ── killSwitched ──────────────────────────────────────────────────────

test("killSwitched: KV has kill:<name> set → true", async () => {
    const kv = mkKV();
    await kv.put("kill:register", "1");
    assert.equal(await killSwitched({ RATE_KV: kv }, "register"), true);
});

test("killSwitched: KV empty → false", async () => {
    assert.equal(await killSwitched({ RATE_KV: mkKV() }, "register"), false);
});

test("killSwitched: missing RATE_KV → false (not fail-closed)", async () => {
    assert.equal(await killSwitched({}, "register"), false);
});
