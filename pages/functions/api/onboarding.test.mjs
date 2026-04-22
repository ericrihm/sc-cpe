// Handler-level tests for the onboarding funnel endpoints:
//   register.js, verify/[token].js, recover.js,
//   me/[token].js, me/[token]/delete.js, me/[token]/resend-code.js
//
// Run: node --test pages/functions/api/onboarding.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestPost as registerPost } from "./register.js";
import { onRequestGet as verifyGet } from "./verify/[token].js";
import { onRequestPost as recoverPost } from "./recover.js";
import { onRequestGet as meGet } from "./me/[token].js";
import { onRequestPost as deletePost } from "./me/[token]/delete.js";
import { onRequestPost as resendPost } from "./me/[token]/resend-code.js";
import { onRequestPost as rotatePost } from "./me/[token]/rotate.js";

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

const kvPermissive = {
    get: async () => null,
    put: async () => {},
};

// Adds Origin for CSRF-passing requests
function req(url, { method = "POST", headers = {}, body } = {}) {
    return new Request(url, {
        method,
        headers: { Origin: new URL(url).origin, ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
}

// Minimal audit_log + email_outbox pass-through rules
const auditRules = [
    {
        match: /FROM audit_log ORDER BY ts DESC/,
        handler: () => ({ first: null }),
    },
    {
        match: /INSERT INTO audit_log/,
        handler: () => ({ run: { meta: {} } }),
    },
];

const emailOutboxRule = {
    match: /INSERT INTO email_outbox/,
    handler: () => ({ run: { meta: {} } }),
};

// Stable fake IDs
const FAKE_ULID = "01HZ99AABBCCDDEEFFGGHH0001";
const FAKE_TOKEN = "a".repeat(64); // 64-char hex dashboard token
const SHORT_TOKEN = "a".repeat(32); // minimal valid token

const BASE = "https://sc-cpe-web.pages.dev";

// ── register.js ───────────────────────────────────────────────────────────

test("register: kill switch set → 503", async () => {
    const killedKv = { get: async (k) => k === "kill:register" ? "1" : null, put: async () => {} };
    const r = await registerPost({
        env: { DB: mockDB([]), RATE_KV: killedKv },
        request: new Request(`${BASE}/api/register`, {
            method: "POST",
            body: JSON.stringify({ email: "a@example.com", legal_name: "A B",
                legal_name_attested: true, age_attested_13plus: true }),
        }),
    });
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.error, "service_temporarily_unavailable");
});

test("recover: kill switch set → 503", async () => {
    const killedKv = { get: async (k) => k === "kill:recover" ? "1" : null, put: async () => {} };
    const r = await recoverPost({
        env: { DB: mockDB([]), RATE_KV: killedKv },
        request: new Request(`${BASE}/api/recover`, {
            method: "POST", headers: { Origin: BASE },
            body: JSON.stringify({ email: "a@example.com" }),
        }),
    });
    assert.equal(r.status, 503);
});

test("register: invalid email returns 400", async () => {
    const r = await registerPost({
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/register`, {
            method: "POST",
            body: JSON.stringify({ email: "not-an-email", legal_name: "Alice Smith",
                legal_name_attested: true, age_attested_13plus: true }),
        }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_email");
});

test("register: invalid name returns 400", async () => {
    const r = await registerPost({
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/register`, {
            method: "POST",
            body: JSON.stringify({ email: "alice@example.com", legal_name: "X",
                legal_name_attested: true, age_attested_13plus: true }),
        }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_name");
});

test("register: missing attestation returns 400", async () => {
    const r = await registerPost({
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/register`, {
            method: "POST",
            body: JSON.stringify({ email: "alice@example.com", legal_name: "Alice Smith",
                legal_name_attested: false, age_attested_13plus: true }),
        }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "legal_name_attestation_required");
});

test("register: existing active user → 409 without token", async () => {
    const db = mockDB([
        {
            match: /FROM users WHERE lower\(email\)/,
            handler: () => ({ first: { id: FAKE_ULID, state: "active", dashboard_token: FAKE_TOKEN } }),
        },
    ]);
    const r = await registerPost({
        env: { DB: db, RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/register`, {
            method: "POST",
            body: JSON.stringify({ email: "alice@example.com", legal_name: "Alice Smith",
                legal_name_attested: true, age_attested_13plus: true }),
        }),
    });
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.error, "already_registered");
    // Must NOT leak the dashboard token
    assert.ok(!JSON.stringify(j).includes(FAKE_TOKEN), "must not expose dashboard_token");
    assert.ok(j.recover_url, "should point to /recover.html");
});

test("register: new user → 200 must NOT leak dashboard_token or verification_code", async () => {
    const db = mockDB([
        {
            match: /FROM users WHERE lower\(email\)/,
            handler: () => ({ first: null }),
        },
        {
            match: /FROM users WHERE verification_code/,
            handler: () => ({ first: null }), // no clash
        },
        {
            match: /INSERT INTO users/,
            handler: () => ({ run: { meta: {} } }),
        },
        ...auditRules,
        emailOutboxRule,
    ]);
    const r = await registerPost({
        env: { DB: db, RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/register`, {
            method: "POST",
            body: JSON.stringify({ email: "alice@example.com", legal_name: "Alice Smith",
                legal_name_attested: true, age_attested_13plus: true }),
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.ok);
    assert.ok(j.email_sent, "must signal that activation is email-only");
    assert.equal(j.dashboard_url, undefined, "must NOT return dashboard_url (email-possession gate)");
    assert.equal(j.verification_code, undefined, "must NOT return verification_code (email-possession gate)");
    assert.equal(j.dashboard_token, undefined, "must NOT return dashboard_token in any form");
});

test("register: rate limit trips when KV reports 10 prior hits this hour", async () => {
    // Defence-in-depth past Turnstile: a solver farm at 10+ Turnstiles/IP/hour
    // gets rate-limited here and stops piling rows into email_outbox + D1.
    // Kill-switch key must return null (not "10") or we'd 503 before reaching
    // the rate-limit branch — that's what exercises a different code path.
    const kvAtLimit = {
        get: async (k) => k.startsWith("kill:") ? null : "10",
        put: async () => {},
    };
    const r = await registerPost({
        env: { DB: mockDB([]), RATE_KV: kvAtLimit },
        request: new Request(`${BASE}/api/register`, {
            method: "POST",
            body: JSON.stringify({ email: "alice@example.com", legal_name: "Alice Smith",
                legal_name_attested: true, age_attested_13plus: true }),
        }),
    });
    assert.equal(r.status, 429);
    const j = await r.json();
    assert.equal(j.error, "rate_limited");
});

test("register: existing pending user re-registers → 200 must NOT leak dashboard_token or code", async () => {
    let updateCalled = false;
    const db = mockDB([
        {
            match: /FROM users WHERE lower\(email\)/,
            handler: () => ({ first: { id: FAKE_ULID, state: "pending_verification", dashboard_token: FAKE_TOKEN } }),
        },
        {
            match: /FROM users WHERE verification_code/,
            handler: () => ({ first: null }),
        },
        {
            match: /UPDATE users SET\s+legal_name/s,
            handler: () => { updateCalled = true; return { run: { meta: {} } }; },
        },
        ...auditRules,
        emailOutboxRule,
    ]);
    const r = await registerPost({
        env: { DB: db, RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/register`, {
            method: "POST",
            body: JSON.stringify({ email: "alice@example.com", legal_name: "Alice Smith",
                legal_name_attested: true, age_attested_13plus: true }),
        }),
    });
    assert.equal(r.status, 200);
    assert.ok(updateCalled, "should UPDATE the existing pending user row");
    const j = await r.json();
    assert.ok(j.ok);
    assert.ok(!JSON.stringify(j).includes(FAKE_TOKEN),
        "response body must not leak pre-existing dashboard_token");
    assert.equal(j.dashboard_url, undefined);
    assert.equal(j.verification_code, undefined);
});

// ── verify/[token].js ─────────────────────────────────────────────────────

test("verify: token too short → 400", async () => {
    const r = await verifyGet({
        params: { token: "short" },
        env: { DB: mockDB([]) },
        request: new Request(`${BASE}/api/verify/short`),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.valid, false);
});

test("verify: unknown token → 404", async () => {
    const db = mockDB([
        { match: /FROM certs c WHERE c\.public_token/, handler: () => ({ first: null }) },
    ]);
    const r = await verifyGet({
        params: { token: "x".repeat(32) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/verify/${"x".repeat(32)}`),
    });
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.equal(j.valid, false);
});

test("verify: generated cert → 200 valid:true", async () => {
    const certRow = {
        id: "c1", public_token: "pt1", period_yyyymm: "202604",
        period_start: "2026-04-01", period_end: "2026-04-30",
        cpe_total: 10, sessions_count: 20,
        issuer_name_snapshot: "Simply Cyber", recipient_name_snapshot: "Alice Smith",
        signing_cert_sha256: "aabbcc", pdf_sha256: "ddeeff",
        state: "generated", revocation_reason: null, revoked_at: null,
        generated_at: "2026-05-01T00:00:00.000Z",
    };
    const db = mockDB([
        { match: /FROM certs c WHERE c\.public_token/, handler: () => ({ first: certRow }) },
        { match: /UPDATE certs SET first_viewed_at/, handler: () => ({ run: {} }) },
        ...auditRules,
    ]);
    const r = await verifyGet({
        params: { token: "x".repeat(32) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/verify/${"x".repeat(32)}`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.valid, true);
    assert.equal(j.recipient, "Alice Smith");
});

test("verify: revoked cert → valid:false with mapped reason", async () => {
    const certRow = {
        id: "c2", public_token: "pt2", period_yyyymm: "202603",
        period_start: "2026-03-01", period_end: "2026-03-31",
        cpe_total: 5, sessions_count: 10,
        issuer_name_snapshot: "Simply Cyber", recipient_name_snapshot: "Bob",
        signing_cert_sha256: "aabb", pdf_sha256: "ccdd",
        state: "revoked", revocation_reason: "fraud detected", revoked_at: "2026-04-01T00:00:00Z",
        generated_at: "2026-04-01T00:00:00Z",
    };
    const db = mockDB([
        { match: /FROM certs c WHERE c\.public_token/, handler: () => ({ first: certRow }) },
        { match: /UPDATE certs SET first_viewed_at/, handler: () => ({ run: {} }) },
        ...auditRules,
    ]);
    const r = await verifyGet({
        params: { token: "x".repeat(32) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/verify/${"x".repeat(32)}`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.valid, false);
    assert.equal(j.revocation_reason, "issued_in_error");
    // Must not leak raw free-text reason
    assert.ok(!JSON.stringify(j).includes("fraud detected"), "must not expose raw revocation reason");
});

// ── recover.js ────────────────────────────────────────────────────────────

test("recover: invalid email → 400", async () => {
    const r = await recoverPost({
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/recover`, {
            method: "POST",
            body: JSON.stringify({ email: "bad-email" }),
        }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_email");
});

test("recover: unknown email → 200 constant response (enumeration resistance)", async () => {
    const db = mockDB([
        { match: /FROM users.*state = 'active'/s, handler: () => ({ first: null }) },
    ]);
    const r = await recoverPost({
        env: { DB: db, RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/recover`, {
            method: "POST",
            body: JSON.stringify({ email: "nobody@example.com" }),
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.ok);
});

test("recover: known active user → 200 + queues email", async () => {
    let emailQueued = false;
    const db = mockDB([
        {
            match: /FROM users.*state = 'active'/s,
            handler: () => ({ first: { id: FAKE_ULID, email: "alice@example.com",
                legal_name: "Alice", dashboard_token: FAKE_TOKEN } }),
        },
        {
            match: /INSERT INTO email_outbox/,
            handler: () => { emailQueued = true; return { run: { meta: {} } }; },
        },
        ...auditRules,
    ]);
    const r = await recoverPost({
        env: { DB: db, RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/recover`, {
            method: "POST",
            body: JSON.stringify({ email: "alice@example.com" }),
        }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.ok);
    assert.ok(emailQueued, "should queue recovery email");
});

// ── me/[token].js ─────────────────────────────────────────────────────────

test("me: token too short → 400", async () => {
    const r = await meGet({
        params: { token: "short" },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/me/short`),
    });
    assert.equal(r.status, 400);
});

test("me: unknown token → 404", async () => {
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({ first: null }) },
    ]);
    const r = await meGet({
        params: { token: SHORT_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/me/${SHORT_TOKEN}`),
    });
    assert.equal(r.status, 404);
});

test("me: valid token → 200 with user, attendance, certs", async () => {
    const db = mockDB([
        {
            match: /FROM users WHERE dashboard_token/,
            handler: () => ({ first: {
                id: FAKE_ULID, email: "alice@example.com", legal_name: "Alice Smith",
                yt_channel_id: null, yt_display_name_seen: null,
                verification_code: "ABC123", code_expires_at: new Date(Date.now() + 1e9).toISOString(),
                state: "pending_verification", email_prefs: null,
                created_at: "2026-01-01T00:00:00Z", verified_at: null,
            }}),
        },
        { match: /FROM attendance a JOIN streams/, handler: () => ({ all: [] }) },
        { match: /FROM certs WHERE user_id.*state != 'regenerated'/s, handler: () => ({ all: [] }) },
        { match: /FROM appeals WHERE user_id/, handler: () => ({ all: [] }) },
        {
            match: /FROM audit_log.*action IN \('code_posted_outside_window'/s,
            handler: () => ({ all: [] }),
        },
        {
            match: /FROM streams s.*WHERE s\.state IN \('live','complete'\)/s,
            handler: () => ({ first: null }),
        },
    ]);
    const r = await meGet({
        params: { token: SHORT_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/me/${SHORT_TOKEN}`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.user, "should have user object");
    assert.equal(j.user.legal_name, "Alice Smith");
    // Verification code value must not be exposed
    assert.ok(!("verification_code" in j.user), "must not expose verification_code value");
    assert.equal(j.user.code_state, "active");
    assert.ok(Array.isArray(j.attendance));
    assert.ok(Array.isArray(j.certs));
});

// ── me/[token]/delete.js ──────────────────────────────────────────────────

test("delete: missing Origin → 403 CSRF", async () => {
    const r = await deletePost({
        params: { token: SHORT_TOKEN },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/me/${SHORT_TOKEN}/delete`, {
            method: "POST",
            body: JSON.stringify({ confirm: "DELETE" }),
        }),
    });
    assert.equal(r.status, 403);
    const j = await r.json();
    assert.equal(j.error, "forbidden_origin");
});

test("delete: missing confirm body → 400", async () => {
    const r = await deletePost({
        params: { token: SHORT_TOKEN },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: req(`${BASE}/api/me/${SHORT_TOKEN}/delete`, { body: { confirm: "no" } }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "confirmation_required");
});

test("delete: unknown token → 404", async () => {
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({ first: null }) },
    ]);
    const r = await deletePost({
        params: { token: SHORT_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req(`${BASE}/api/me/${SHORT_TOKEN}/delete`, { body: { confirm: "DELETE" } }),
    });
    assert.equal(r.status, 404);
});

test("delete: valid request → 200 scrubs user", async () => {
    let updateCalled = false;
    const db = mockDB([
        {
            match: /FROM users WHERE dashboard_token/,
            handler: () => ({ first: { id: FAKE_ULID, email: "alice@example.com",
                state: "active", deleted_at: null } }),
        },
        {
            match: /UPDATE users\s+SET email/s,
            handler: () => { updateCalled = true; return { run: { meta: {} } }; },
        },
        ...auditRules,
    ]);
    const r = await deletePost({
        params: { token: SHORT_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req(`${BASE}/api/me/${SHORT_TOKEN}/delete`, { body: { confirm: "DELETE" } }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.ok);
    assert.ok(j.certs_retained, "must confirm cert retention");
    assert.ok(updateCalled, "must UPDATE the user row");
});

// ── me/[token]/resend-code.js ─────────────────────────────────────────────

test("resend-code: missing Origin → 403 CSRF", async () => {
    const r = await resendPost({
        params: { token: SHORT_TOKEN },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/me/${SHORT_TOKEN}/resend-code`, {
            method: "POST",
        }),
    });
    assert.equal(r.status, 403);
    const j = await r.json();
    assert.equal(j.error, "forbidden_origin");
});

test("resend-code: already active user with linked channel → 409", async () => {
    const db = mockDB([
        {
            match: /FROM users WHERE dashboard_token.*deleted_at IS NULL/s,
            handler: () => ({ first: { id: FAKE_ULID, email: "alice@example.com",
                legal_name: "Alice", state: "active", dashboard_token: FAKE_TOKEN,
                yt_channel_id: "UC1234567890" } }),
        },
    ]);
    const r = await resendPost({
        params: { token: SHORT_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req(`${BASE}/api/me/${SHORT_TOKEN}/resend-code`),
    });
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.error, "already_verified");
});

test("resend-code: pending user → 200 issues new code", async () => {
    let updateCalled = false;
    const db = mockDB([
        {
            match: /FROM users WHERE dashboard_token.*deleted_at IS NULL/s,
            handler: () => ({ first: { id: FAKE_ULID, email: "alice@example.com",
                legal_name: "Alice", state: "pending_verification", dashboard_token: FAKE_TOKEN } }),
        },
        {
            match: /FROM users WHERE verification_code/,
            handler: () => ({ first: null }),
        },
        {
            match: /UPDATE users SET verification_code/,
            handler: () => { updateCalled = true; return { run: { meta: {} } }; },
        },
        emailOutboxRule,
        ...auditRules,
    ]);
    const r = await resendPost({
        params: { token: SHORT_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req(`${BASE}/api/me/${SHORT_TOKEN}/resend-code`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.ok);
    assert.ok(j.code_expires_at, "should return new expiry");
    assert.ok(updateCalled, "must UPDATE verification_code");
});

test("resend-code: unknown token → 404", async () => {
    const db = mockDB([
        {
            match: /FROM users WHERE dashboard_token.*deleted_at IS NULL/s,
            handler: () => ({ first: null }),
        },
    ]);
    const r = await resendPost({
        params: { token: SHORT_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req(`${BASE}/api/me/${SHORT_TOKEN}/resend-code`),
    });
    assert.equal(r.status, 404);
});

// ── me/[token]/rotate.js ──────────────────────────────────────────────────

test("rotate: updates dashboard_token, queues email, returns no new token", async () => {
    let updatedToken = null;
    let queuedTo = null;
    const db = mockDB([
        {
            match: /FROM users WHERE dashboard_token.*deleted_at IS NULL/s,
            handler: () => ({ first: { id: FAKE_ULID, email: "alice@example.com", legal_name: "Alice Smith" } }),
        },
        {
            match: /UPDATE users SET dashboard_token = \?1, badge_token = \?2 WHERE id = \?3/,
            handler: (_sql, binds) => { updatedToken = binds[0]; return { run: { meta: {} } }; },
        },
        {
            match: /INSERT INTO email_outbox/,
            handler: (_sql, binds) => { queuedTo = binds.find(b => String(b).includes("@")); return { run: { meta: {} } }; },
        },
        ...auditRules,
    ]);
    const r = await rotatePost({
        params: { token: FAKE_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req(`${BASE}/api/me/${FAKE_TOKEN}/rotate`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.ok);
    assert.ok(j.email_sent);
    // Response body must NOT leak the new token (same philosophy as /register)
    assert.equal(j.dashboard_url, undefined);
    assert.equal(j.dashboard_token, undefined);
    // UPDATE must have fired with a fresh 64-hex token
    assert.ok(updatedToken, "UPDATE users SET dashboard_token must run");
    assert.notEqual(updatedToken, FAKE_TOKEN, "new token must differ from old");
    assert.match(updatedToken, /^[0-9a-f]{64}$/, "new token must be 64-hex");
    // Email must be queued to the on-file address
    assert.equal(queuedTo, "alice@example.com");
});

test("rotate: cross-origin request → 403 (CSRF gate)", async () => {
    const r = await rotatePost({
        params: { token: FAKE_TOKEN },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/me/${FAKE_TOKEN}/rotate`, {
            method: "POST",
            headers: { Origin: "https://attacker.example" },
        }),
    });
    assert.equal(r.status, 403);
    const j = await r.json();
    assert.equal(j.error, "forbidden_origin");
});

test("rotate: unknown token → 404", async () => {
    const db = mockDB([
        {
            match: /FROM users WHERE dashboard_token.*deleted_at IS NULL/s,
            handler: () => ({ first: null }),
        },
    ]);
    const r = await rotatePost({
        params: { token: SHORT_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req(`${BASE}/api/me/${SHORT_TOKEN}/rotate`),
    });
    assert.equal(r.status, 404);
});

test("rotate: rate limit trips when KV reports 3 prior hits this hour", async () => {
    const kvAtLimit = { get: async () => "3", put: async () => {} };
    const db = mockDB([
        {
            match: /FROM users WHERE dashboard_token.*deleted_at IS NULL/s,
            handler: () => ({ first: { id: FAKE_ULID, email: "a@example.com", legal_name: "A" } }),
        },
    ]);
    const r = await rotatePost({
        params: { token: FAKE_TOKEN },
        env: { DB: db, RATE_KV: kvAtLimit },
        request: req(`${BASE}/api/me/${FAKE_TOKEN}/rotate`),
    });
    assert.equal(r.status, 429);
});
