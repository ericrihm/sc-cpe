import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestPost as certResendPost } from "./[token]/cert-resend/[cert_id].js";
import { onRequestGet as unsubGet, onRequestPost as unsubPost } from "./[token]/unsubscribe.js";

const BASE = "https://sc-cpe-web.pages.dev";
const VALID_TOKEN = "a".repeat(64);

function stubDB(overrides = {}) {
    const noop = { meta: {} };
    return {
        prepare(sql) {
            const handler = Object.entries(overrides).find(([pattern]) =>
                new RegExp(pattern, "i").test(sql)
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

function mkKV(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        get: async (k) => store.get(k) ?? null,
        put: async (k, v) => { store.set(k, v); },
        delete: async (k) => { store.delete(k); },
    };
}

// ── cert-resend ─────────────────────────────────────────────────────────

test("cert-resend: missing origin → 403", async () => {
    const r = await certResendPost({
        params: { token: VALID_TOKEN, cert_id: "01CERTID1234" },
        env: { DB: stubDB(), SITE_ORIGIN: BASE },
        request: new Request(`${BASE}/api/me/${VALID_TOKEN}/cert-resend/01CERTID1234`, {
            method: "POST",
        }),
    });
    assert.equal(r.status, 403);
});

test("cert-resend: cert not found → 404", async () => {
    const db = stubDB({
        "FROM users WHERE dashboard_token": () => ({ id: "01U" }),
        "FROM certs WHERE id": () => null,
    });
    const r = await certResendPost({
        params: { token: VALID_TOKEN, cert_id: "01CERTID1234" },
        env: { DB: db, RATE_KV: mkKV(), SITE_ORIGIN: BASE },
        request: new Request(`${BASE}/api/me/${VALID_TOKEN}/cert-resend/01CERTID1234`, {
            method: "POST",
            headers: { Origin: BASE },
        }),
    });
    assert.equal(r.status, 404);
});

test("cert-resend: not eligible (pending cert) → 400", async () => {
    const db = stubDB({
        "FROM users WHERE dashboard_token": () => ({ id: "01U" }),
        "FROM certs WHERE id": () => ({ id: "01C", public_token: "x".repeat(64), user_id: "01U", state: "pending" }),
    });
    const r = await certResendPost({
        params: { token: VALID_TOKEN, cert_id: "01C" },
        env: { DB: db, RATE_KV: mkKV(), SITE_ORIGIN: BASE },
        request: new Request(`${BASE}/api/me/${VALID_TOKEN}/cert-resend/01C`, {
            method: "POST",
            headers: { Origin: BASE },
        }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "not_eligible");
});

test("cert-resend: valid → 200", async () => {
    const db = stubDB({
        "FROM users WHERE dashboard_token": () => ({ id: "01U" }),
        "FROM certs WHERE id": () => ({ id: "01C", public_token: "x".repeat(64), user_id: "01U", state: "delivered" }),
        "FROM email_outbox WHERE idempotency_key": () => ({ state: "bounced" }),
        "SELECT email, legal_name, dashboard_token FROM users": () => ({
            email: "test@example.com", legal_name: "Test", dashboard_token: VALID_TOKEN,
        }),
        "INSERT INTO email_outbox": () => null,
    });
    const r = await certResendPost({
        params: { token: VALID_TOKEN, cert_id: "01C" },
        env: { DB: db, RATE_KV: mkKV(), SITE_ORIGIN: BASE },
        request: new Request(`${BASE}/api/me/${VALID_TOKEN}/cert-resend/01C`, {
            method: "POST",
            headers: { Origin: BASE },
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.message, "Cert email re-queued");
});

// ── unsubscribe GET ─────────────────────────────────────────────────────

test("unsubscribe GET: returns HTML page", async () => {
    const db = stubDB({
        "FROM users WHERE dashboard_token": () => ({ id: "01U" }),
    });
    const r = await unsubGet({
        params: { token: VALID_TOKEN },
        env: { DB: db },
        request: new Request(`${BASE}/api/me/${VALID_TOKEN}/unsubscribe?cat=monthly_digest`),
    });
    assert.equal(r.status, 200);
    const ct = r.headers.get("Content-Type");
    assert.ok(ct.includes("text/html"));
    const body = await r.text();
    assert.ok(body.includes("Monthly Digest"));
    assert.ok(body.includes("Unsubscribe"));
});

test("unsubscribe GET: invalid category → 400", async () => {
    const r = await unsubGet({
        params: { token: VALID_TOKEN },
        env: { DB: stubDB() },
        request: new Request(`${BASE}/api/me/${VALID_TOKEN}/unsubscribe?cat=bogus`),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_category");
});

// ── unsubscribe POST ────────────────────────────────────────────────────

test("unsubscribe POST: toggles category", async () => {
    const db = stubDB({
        "FROM users WHERE dashboard_token": () => ({
            id: "01U", email_prefs: JSON.stringify({ unsubscribed: [] }),
        }),
        "UPDATE users SET email_prefs": () => null,
    });
    const r = await unsubPost({
        params: { token: VALID_TOKEN },
        env: { DB: db },
        request: new Request(`${BASE}/api/me/${VALID_TOKEN}/unsubscribe?cat=cert_nudge`, {
            method: "POST",
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.unsubscribed, "cert_nudge");
});

test("unsubscribe POST: invalid category → 400", async () => {
    const r = await unsubPost({
        params: { token: VALID_TOKEN },
        env: { DB: stubDB() },
        request: new Request(`${BASE}/api/me/${VALID_TOKEN}/unsubscribe?cat=invalid`, {
            method: "POST",
        }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_category");
});
