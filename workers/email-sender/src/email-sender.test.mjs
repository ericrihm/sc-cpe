import { test } from "node:test";
import assert from "node:assert/strict";

const mod = await import("./index.js");
const handler = mod.default;

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
                run: async () => handler ? (handler[1](sql, binds) ?? { meta: { changes: 1 } }) : { meta: { changes: 1 } },
            };
            return stmt;
        },
    };
}

function mkRow(overrides = {}) {
    return {
        id: "01ROW",
        user_id: "01USER",
        template: "monthly_cert",
        to_email: "test@example.com",
        subject: "Your cert",
        payload_json: JSON.stringify({ html_body: "<p>Hi</p>", text_body: "Hi" }),
        idempotency_key: "idem_01ROW",
        attempts: 0,
        ...overrides,
    };
}

// ── fetch handler ─────────────────────────────────────────────────────

test("fetch: non-/drain path → 404", async () => {
    const r = await handler.fetch(
        new Request("https://worker.dev/other", { method: "POST" }),
        {},
    );
    assert.equal(r.status, 404);
});

test("fetch: GET /drain → 405", async () => {
    const r = await handler.fetch(
        new Request("https://worker.dev/drain"),
        {},
    );
    assert.equal(r.status, 405);
});

test("fetch: POST /drain without auth → 401", async () => {
    const r = await handler.fetch(
        new Request("https://worker.dev/drain", { method: "POST" }),
        { ADMIN_TOKEN: "secret" },
    );
    assert.equal(r.status, 401);
});

test("fetch: POST /drain with correct auth → 200", async () => {
    const db = stubDB({
        "UPDATE email_outbox SET state = 'queued'": () => ({ meta: {} }),
        "FROM email_outbox.*WHERE state = 'queued'.*ORDER": () => [],
        "COUNT.*FROM email_outbox": () => ({ n: 0 }),
        "MIN.*FROM email_outbox": () => ({ ts: null }),
        "INSERT INTO heartbeats": () => null,
    });
    const r = await handler.fetch(
        new Request("https://worker.dev/drain", {
            method: "POST",
            headers: { Authorization: "Bearer secret" },
        }),
        { ADMIN_TOKEN: "secret", RESEND_API_KEY: "re_test", FROM_EMAIL: "noreply@x.com", DB: db },
    );
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.attempted, 0);
    assert.equal(j.sent, 0);
});

// ── drain logic ───────────────────────────────────────────────────────

test("drain: missing RESEND_API_KEY → throws", async () => {
    const db = stubDB({
        "INSERT INTO heartbeats": () => null,
    });
    await assert.rejects(
        handler.fetch(
            new Request("https://worker.dev/drain", {
                method: "POST",
                headers: { Authorization: "Bearer secret" },
            }),
            { ADMIN_TOKEN: "secret", DB: db, FROM_EMAIL: "noreply@x.com" },
        ),
        /RESEND_API_KEY_unset/,
    );
});

test("drain: suppressed email → marked bounced, not sent", async () => {
    const row = mkRow();
    let finalState = null;
    let finalError = null;
    const db = stubDB({
        "UPDATE email_outbox SET state = 'queued'": () => ({ meta: {} }),
        "FROM email_outbox.*WHERE state = 'queued'.*ORDER": () => [row],
        "UPDATE email_outbox SET state = 'sending'": () => ({ meta: { changes: 1 } }),
        "FROM email_suppression WHERE email": () => ({ "1": 1 }),
        "UPDATE email_outbox.*SET state = 'bounced'": (sql, binds) => {
            finalState = "bounced";
            return { meta: { changes: 1 } };
        },
        "COUNT.*FROM email_outbox": () => ({ n: 0 }),
        "MIN.*FROM email_outbox": () => ({ ts: null }),
        "INSERT INTO heartbeats": () => null,
    });
    const r = await handler.fetch(
        new Request("https://worker.dev/drain", {
            method: "POST",
            headers: { Authorization: "Bearer secret" },
        }),
        { ADMIN_TOKEN: "secret", RESEND_API_KEY: "re_test", FROM_EMAIL: "noreply@x.com", DB: db },
    );
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.failed, 1);
    assert.equal(j.sent, 0);
    assert.equal(finalState, "bounced");
});

test("drain: successful Resend POST → state = sent", async () => {
    const row = mkRow();
    let sentId = null;
    const db = stubDB({
        "UPDATE email_outbox SET state = 'queued'": () => ({ meta: {} }),
        "FROM email_outbox.*WHERE state = 'queued'.*ORDER": () => [row],
        "UPDATE email_outbox SET state = 'sending'": () => ({ meta: { changes: 1 } }),
        "FROM email_suppression WHERE email": () => null,
        "UPDATE email_outbox.*SET state = 'sent'": (sql, binds) => {
            sentId = binds[2];
            return { meta: { changes: 1 } };
        },
        "COUNT.*FROM email_outbox": () => ({ n: 0 }),
        "MIN.*FROM email_outbox": () => ({ ts: null }),
        "INSERT INTO heartbeats": () => null,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        if (url === "https://api.resend.com/emails") {
            return new Response(JSON.stringify({ id: "resend_msg_123" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        return origFetch(url, opts);
    };
    try {
        const r = await handler.fetch(
            new Request("https://worker.dev/drain", {
                method: "POST",
                headers: { Authorization: "Bearer secret" },
            }),
            { ADMIN_TOKEN: "secret", RESEND_API_KEY: "re_test", FROM_EMAIL: "noreply@x.com", DB: db },
        );
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.sent, 1);
        assert.equal(j.failed, 0);
        assert.equal(sentId, "01ROW");
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("drain: Resend 4xx → row back to queued with error", async () => {
    const row = mkRow({ attempts: 0 });
    let errorState = null;
    let lastError = null;
    const db = stubDB({
        "UPDATE email_outbox SET state = 'queued'.*WHERE state = 'sending'": () => ({ meta: {} }),
        "FROM email_outbox.*WHERE state = 'queued'.*ORDER": () => [row],
        "UPDATE email_outbox SET state = 'sending'": () => ({ meta: { changes: 1 } }),
        "FROM email_suppression WHERE email": () => null,
        "UPDATE email_outbox.*SET state = \\?": (sql, binds) => {
            errorState = binds[0];
            lastError = binds[1];
            return { meta: { changes: 1 } };
        },
        "COUNT.*FROM email_outbox": () => ({ n: 0 }),
        "MIN.*FROM email_outbox": () => ({ ts: null }),
        "INSERT INTO heartbeats": () => null,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (url === "https://api.resend.com/emails") {
            return new Response(JSON.stringify({ message: "bad request" }), { status: 400 });
        }
        return origFetch(url);
    };
    try {
        const r = await handler.fetch(
            new Request("https://worker.dev/drain", {
                method: "POST",
                headers: { Authorization: "Bearer secret" },
            }),
            { ADMIN_TOKEN: "secret", RESEND_API_KEY: "re_test", FROM_EMAIL: "noreply@x.com", DB: db },
        );
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.failed, 1);
        assert.equal(errorState, "queued");
        assert.ok(lastError.includes("resend_400"));
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("drain: max attempts reached → state = failed permanently", async () => {
    const row = mkRow({ attempts: 4 });
    let errorState = null;
    const db = stubDB({
        "UPDATE email_outbox SET state = 'queued'.*WHERE state = 'sending'": () => ({ meta: {} }),
        "FROM email_outbox.*WHERE state = 'queued'.*ORDER": () => [row],
        "UPDATE email_outbox SET state = 'sending'": () => ({ meta: { changes: 1 } }),
        "FROM email_suppression WHERE email": () => null,
        "UPDATE email_outbox.*SET state = \\?": (sql, binds) => {
            errorState = binds[0];
            return { meta: { changes: 1 } };
        },
        "COUNT.*FROM email_outbox": () => ({ n: 0 }),
        "MIN.*FROM email_outbox": () => ({ ts: null }),
        "INSERT INTO heartbeats": () => null,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (url === "https://api.resend.com/emails") {
            return new Response("server error", { status: 500 });
        }
        return origFetch(url);
    };
    try {
        const r = await handler.fetch(
            new Request("https://worker.dev/drain", {
                method: "POST",
                headers: { Authorization: "Bearer secret" },
            }),
            { ADMIN_TOKEN: "secret", RESEND_API_KEY: "re_test", FROM_EMAIL: "noreply@x.com", DB: db },
        );
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.failed, 1);
        assert.equal(errorState, "failed");
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("drain: writes heartbeat on each run", async () => {
    let heartbeatWritten = false;
    const db = stubDB({
        "UPDATE email_outbox SET state = 'queued'": () => ({ meta: {} }),
        "FROM email_outbox.*WHERE state = 'queued'.*ORDER": () => [],
        "COUNT.*FROM email_outbox": () => ({ n: 0 }),
        "MIN.*FROM email_outbox": () => ({ ts: null }),
        "INSERT INTO heartbeats": () => { heartbeatWritten = true; return null; },
    });
    await handler.fetch(
        new Request("https://worker.dev/drain", {
            method: "POST",
            headers: { Authorization: "Bearer secret" },
        }),
        { ADMIN_TOKEN: "secret", RESEND_API_KEY: "re_test", FROM_EMAIL: "noreply@x.com", DB: db },
    );
    assert.ok(heartbeatWritten, "heartbeat should be written");
});
