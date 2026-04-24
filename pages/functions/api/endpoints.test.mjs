// Handler-level tests for the bundled/per-session + reissue + feedback
// endpoints shipped in commit 865be68. These use a minimal in-memory D1
// mock that pattern-matches on SQL fragments — not a full SQL engine, just
// enough to exercise the handler's branching without hitting real D1.
//
// Run: node --test pages/functions/api/endpoints.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestPost as prefsPost } from "./me/[token]/prefs.js";
import { onRequestPost as perSessionPost } from "./me/[token]/cert-per-session/[stream_id].js";
import { onRequestGet as feedbackGet } from "./admin/cert-feedback.js";
import { onRequestPost as reissuePost } from "./admin/cert/[id]/reissue.js";

// Minimal D1 mock. `rules` is an array of {match: RegExp, handler: (sql,
// binds) => { first?, all?, run? }}. First match wins; unmatched SQL
// throws so tests fail loudly on drift.
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

// RATE_KV stub — always allows. rate-limit rejection path is covered by
// _lib.test.mjs; here we're testing the endpoint's own logic.
const kvPermissive = {
    get: async () => null,
    put: async () => {},
};

function req(url, { method = "POST", headers = {}, body } = {}) {
    return new Request(url, {
        method, headers: { Origin: new URL(url).origin, ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
}

// ── prefs.js ──────────────────────────────────────────────────────────

test("prefs: rejects missing Origin (CSRF)", async () => {
    const r = await prefsPost({
        params: { token: "a".repeat(64) },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: new Request("https://sc-cpe-web.pages.dev/api/me/x/prefs",
            { method: "POST", body: "{}" }),
    });
    assert.equal(r.status, 403);
});

test("prefs: rejects invalid cert_style", async () => {
    const r = await prefsPost({
        params: { token: "a".repeat(64) },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/prefs",
            { body: { cert_style: "bogus" } }),
    });
    assert.equal(r.status, 400);
});

test("prefs: merges into existing email_prefs JSON", async () => {
    let updateBinds = null;
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({
            first: { id: "u1", email_prefs: JSON.stringify({ foo: "bar" }) },
        })},
        { match: /UPDATE users SET email_prefs/, handler: (_s, b) => {
            updateBinds = b;
            return { run: { meta: {} } };
        }},
    ]);
    const r = await prefsPost({
        params: { token: "a".repeat(64) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/prefs",
            { body: { cert_style: "per_session" } }),
    });
    assert.equal(r.status, 200);
    const merged = JSON.parse(updateBinds[0]);
    assert.equal(merged.foo, "bar", "preserves existing keys");
    assert.equal(merged.cert_style, "per_session", "applies new key");
});

// ── cert-per-session ──────────────────────────────────────────────────

test("cert-per-session: rejects missing Origin", async () => {
    const r = await perSessionPost({
        params: { token: "a".repeat(64), stream_id: "stream-0001" },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: new Request(
            "https://sc-cpe-web.pages.dev/api/me/x/cert-per-session/stream-0001",
            { method: "POST" }),
    });
    assert.equal(r.status, 403);
});

test("cert-per-session: owner mismatch → 404", async () => {
    const db = mockDB([
        { match: /FROM users u.*JOIN attendance/s, handler: () => ({ first: null }) },
    ]);
    const r = await perSessionPost({
        params: { token: "a".repeat(64), stream_id: "stream-0001" },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req(
            "https://sc-cpe-web.pages.dev/api/me/x/cert-per-session/stream-0001"),
    });
    assert.equal(r.status, 404);
});

test("cert-per-session: existing non-revoked cert → returns it, no insert", async () => {
    let inserted = false;
    const db = mockDB([
        { match: /FROM users u.*JOIN attendance/s, handler: () => ({ first: {
            user_id: "u1", email: "a@b.co", legal_name: "A",
            stream_pk: "s1", yt_video_id: "v1",
            scheduled_date: "2026-04-10", earned_cpe: 1,
        }})},
        { match: /WHERE user_id = \?1 AND stream_id = \?2/, handler: () => ({
            first: { id: "c1", public_token: "pt", state: "generated" },
        })},
        { match: /INSERT INTO certs/, handler: () => { inserted = true; return { run: {} }; }},
    ]);
    const r = await perSessionPost({
        params: { token: "a".repeat(64), stream_id: "stream-0001" },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req(
            "https://sc-cpe-web.pages.dev/api/me/x/cert-per-session/stream-0001"),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.existing, true);
    assert.equal(j.cert_id, "c1");
    assert.equal(inserted, false, "must not insert when cert already exists");
});

// ── admin/cert-feedback ───────────────────────────────────────────────

test("cert-feedback: requires bearer", async () => {
    const r = await feedbackGet({
        env: { DB: mockDB([]) },
        request: new Request("https://sc-cpe-web.pages.dev/api/admin/cert-feedback"),
    });
    assert.equal(r.status, 401);
});

test("cert-feedback: returns empty list when no non-ok rows", async () => {
    const db = mockDB([
        { match: /FROM cert_feedback/, handler: () => ({ all: [] })},
        { match: /FROM certs\s+WHERE supersedes_cert_id/s, handler: () => ({ all: [] })},
    ]);
    const r = await feedbackGet({
        env: { DB: db, ADMIN_TOKEN: "tok" },
        request: new Request("https://sc-cpe-web.pages.dev/api/admin/cert-feedback",
            { headers: { Authorization: "Bearer tok" }}),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.count, 0);
});

// ── admin/cert/[id]/reissue ───────────────────────────────────────────

test("reissue: requires bearer", async () => {
    const r = await reissuePost({
        params: { id: "c1" },
        env: { DB: mockDB([]) },
        request: new Request(
            "https://sc-cpe-web.pages.dev/api/admin/cert/c1/reissue",
            { method: "POST", body: JSON.stringify({ reason: "typo" }) }),
    });
    assert.equal(r.status, 401);
});

test("reissue: rejects missing reason", async () => {
    const r = await reissuePost({
        params: { id: "0123456789abcdef" },
        env: { DB: mockDB([]), ADMIN_TOKEN: "tok" },
        request: new Request(
            "https://sc-cpe-web.pages.dev/api/admin/cert/c1/reissue",
            { method: "POST",
              headers: { Authorization: "Bearer tok" },
              body: JSON.stringify({}) }),
    });
    assert.equal(r.status, 400);
});

test("reissue: rejects revoked cert", async () => {
    const db = mockDB([
        { match: /FROM certs WHERE id/, handler: () => ({
            first: { id: "c1", state: "revoked", cert_kind: "bundled" },
        })},
    ]);
    const r = await reissuePost({
        params: { id: "0123456789abcdef" },
        env: { DB: db, ADMIN_TOKEN: "tok" },
        request: new Request(
            "https://sc-cpe-web.pages.dev/api/admin/cert/c1/reissue",
            { method: "POST",
              headers: { Authorization: "Bearer tok" },
              body: JSON.stringify({ reason: "forged" }) }),
    });
    assert.equal(r.status, 409);
});

test("reissue: returns existing pending supersedes instead of double-inserting", async () => {
    let inserted = false;
    const db = mockDB([
        { match: /FROM certs WHERE id/, handler: () => ({
            first: { id: "c1", user_id: "u1", period_yyyymm: "202604",
                     state: "generated", cert_kind: "bundled" },
        })},
        { match: /FROM certs WHERE supersedes_cert_id.*pending/s, handler: () => ({
            first: { id: "c2", state: "pending" },
        })},
        { match: /INSERT INTO certs/, handler: () => { inserted = true; return { run: {} }; }},
    ]);
    const r = await reissuePost({
        params: { id: "0123456789abcdef" },
        env: { DB: db, ADMIN_TOKEN: "tok" },
        request: new Request(
            "https://sc-cpe-web.pages.dev/api/admin/cert/c1/reissue",
            { method: "POST",
              headers: { Authorization: "Bearer tok" },
              body: JSON.stringify({ reason: "typo in name" }) }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.reissued, false);
    assert.equal(j.pending_cert_id, "c2");
    assert.equal(inserted, false);
});
