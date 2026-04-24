// Handler-level tests for the Resend bounce/complaint webhook endpoint.
//
// Run: node --test pages/functions/api/email-webhook.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestPost as webhookPost } from "./email-webhook.js";

// ── helpers ───────────────────────────────────────────────────────────────

function mockDB(rules) {
    return {
        prepare(sql) {
            const rule = rules.find(r => r.match.test(sql));
            if (!rule) throw new Error("no mock rule matched SQL: " + sql.slice(0, 120));
            let binds = [];
            const stmt = {
                bind(...args) { binds = args; return stmt; },
                first: async () => rule.handler(sql, binds).first ?? null,
                all: async () => ({ results: rule.handler(sql, binds).all ?? [] }),
                run: async () => rule.handler(sql, binds).run ?? { meta: {} },
            };
            return stmt;
        },
    };
}

// DB that accepts all writes silently — used for the no-secret path.
function openDB() {
    return mockDB([
        { match: /UPDATE email_outbox/, handler: () => ({ run: {} }) },
        { match: /INSERT INTO email_suppression/, handler: () => ({ run: {} }) },
        { match: /INSERT INTO audit_log/, handler: () => ({ run: {} }) },
        { match: /SELECT.*FROM audit_log/s, handler: () => ({ first: null }) },
    ]);
}

function postReq(url, body, headers = {}) {
    const bodyStr = JSON.stringify(body);
    return new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: bodyStr,
    });
}

const BASE = "https://sc-cpe-web.pages.dev/api/email-webhook";

// ── no-secret mode (initial setup) ───────────────────────────────────────

test("webhook: no secret configured → accepts all requests", async () => {
    const r = await webhookPost({
        env: { DB: openDB() },
        request: postReq(BASE, { type: "email.delivered", data: {} }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.ok);
});

// ── signature required when secret is set ────────────────────────────────

test("webhook: missing svix headers → 401", async () => {
    const r = await webhookPost({
        env: { DB: openDB(), RESEND_WEBHOOK_SECRET: "whsec_dGVzdHNlY3JldA==" },
        request: postReq(BASE, { type: "email.delivered" }),
    });
    assert.equal(r.status, 401);
    const j = await r.json();
    assert.equal(j.error, "invalid_signature");
});

test("webhook: stale timestamp → 401", async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 600); // 10 min ago
    const r = await webhookPost({
        env: { DB: openDB(), RESEND_WEBHOOK_SECRET: "whsec_dGVzdHNlY3JldA==" },
        request: postReq(BASE, { type: "email.bounced" }, {
            "svix-id": "msg_test",
            "svix-timestamp": staleTs,
            "svix-signature": "v1,invalidsig",
        }),
    });
    assert.equal(r.status, 401);
});

// ── event type routing ────────────────────────────────────────────────────

test("webhook: email.delivered → 200 ok, no DB writes", async () => {
    let dbCalled = false;
    const db = mockDB([
        { match: /UPDATE email_outbox|INSERT INTO/, handler: () => { dbCalled = true; return {}; } },
    ]);
    const r = await webhookPost({
        env: { DB: db },
        request: postReq(BASE, { type: "email.delivered", data: {} }),
    });
    assert.equal(r.status, 200);
    assert.equal(dbCalled, false, "no DB writes for delivery events");
});

test("webhook: email.opened → 200 ok, no DB writes", async () => {
    let dbCalled = false;
    const db = mockDB([
        { match: /UPDATE|INSERT/, handler: () => { dbCalled = true; return {}; } },
    ]);
    const r = await webhookPost({
        env: { DB: db },
        request: postReq(BASE, { type: "email.opened", data: {} }),
    });
    assert.equal(r.status, 200);
    assert.equal(dbCalled, false);
});

test("webhook: unknown type → 200 ok, no DB writes", async () => {
    let dbCalled = false;
    const db = mockDB([
        { match: /UPDATE|INSERT/, handler: () => { dbCalled = true; return {}; } },
    ]);
    const r = await webhookPost({
        env: { DB: db },
        request: postReq(BASE, { type: "email.something_new", data: {} }),
    });
    assert.equal(r.status, 200);
    assert.equal(dbCalled, false);
});

// ── bounce handling ───────────────────────────────────────────────────────

test("webhook: email.bounced → outbox marked bounced, suppression inserted, audit written", async () => {
    let outboxUpdated = false, suppressionInserted = false, auditWritten = false;
    const db = mockDB([
        { match: /UPDATE email_outbox/, handler: () => { outboxUpdated = true; return { run: {} }; } },
        { match: /INSERT INTO email_suppression/, handler: () => { suppressionInserted = true; return { run: {} }; } },
        { match: /INSERT INTO audit_log/, handler: () => { auditWritten = true; return { run: {} }; } },
        { match: /SELECT.*FROM audit_log/s, handler: () => ({ first: null }) },
    ]);
    const r = await webhookPost({
        env: { DB: db },
        request: postReq(BASE, {
            type: "email.bounced",
            data: { email_id: "resend_abc123", to: ["test@example.com"] },
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.ok);
    assert.equal(outboxUpdated, true, "outbox row must be marked bounced");
    assert.equal(suppressionInserted, true, "address must be suppressed");
    assert.equal(auditWritten, true, "audit row must be written");
});

test("webhook: email.complained → same treatment as bounce", async () => {
    let suppressionInserted = false, auditWritten = false;
    let suppressionReason = null;
    const db = mockDB([
        { match: /UPDATE email_outbox/, handler: () => ({ run: {} }) },
        { match: /INSERT INTO email_suppression/, handler: (_s, b) => {
            suppressionInserted = true;
            suppressionReason = b[1]; // reason is second bind param
            return { run: {} };
        }},
        { match: /INSERT INTO audit_log/, handler: () => { auditWritten = true; return { run: {} }; } },
        { match: /SELECT.*FROM audit_log/s, handler: () => ({ first: null }) },
    ]);
    const r = await webhookPost({
        env: { DB: db },
        request: postReq(BASE, {
            type: "email.complained",
            data: { email_id: "resend_def456", to: ["spammer@example.com"] },
        }),
    });
    assert.equal(r.status, 200);
    assert.equal(suppressionInserted, true);
    assert.equal(suppressionReason, "spam_complaint");
    assert.equal(auditWritten, true);
});

test("webhook: missing to field → 400", async () => {
    const r = await webhookPost({
        env: { DB: openDB() },
        request: postReq(BASE, {
            type: "email.bounced",
            data: { email_id: "resend_xyz" },  // no to field
        }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "missing_email");
});

test("webhook: bounce without email_id → suppression still inserted, no outbox update", async () => {
    let outboxUpdated = false, suppressionInserted = false;
    const db = mockDB([
        { match: /UPDATE email_outbox/, handler: () => { outboxUpdated = true; return { run: {} }; } },
        { match: /INSERT INTO email_suppression/, handler: () => { suppressionInserted = true; return { run: {} }; } },
        { match: /INSERT INTO audit_log/, handler: () => ({ run: {} }) },
        { match: /SELECT.*FROM audit_log/s, handler: () => ({ first: null }) },
    ]);
    const r = await webhookPost({
        env: { DB: db },
        request: postReq(BASE, {
            type: "email.bounced",
            data: { to: ["noid@example.com"] },  // no email_id
        }),
    });
    assert.equal(r.status, 200);
    assert.equal(outboxUpdated, false, "no outbox update without email_id");
    assert.equal(suppressionInserted, true, "suppression still inserted");
});

test("webhook: invalid JSON body → 400", async () => {
    const r = await webhookPost({
        env: { DB: openDB() },
        request: new Request(BASE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "not-json{{{",
        }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_json");
});
