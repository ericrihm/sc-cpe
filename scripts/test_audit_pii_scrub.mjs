// Guards against PII regressions in audit_log after_json. audit_log is
// append-only and survives user deletion — any free-text PII that lands
// there is effectively un-erasable. Each endpoint below MUST write only
// hashes / classifiers / counts, never the raw email / name / query /
// admin free-text reason.

import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestPost as registerPost } from "../pages/functions/api/register.js";
import { onRequestPost as recoverPost } from "../pages/functions/api/recover.js";
import { onRequestGet as usersGet } from "../pages/functions/api/admin/users.js";
import { onRequestPost as revokePost } from "../pages/functions/api/admin/revoke.js";

const BASE = "https://sc-cpe-web.pages.dev";
const FAKE_ULID = "01HZ99AABBCCDDEEFFGGHH0001";
const FAKE_TOKEN = "a".repeat(64);
const EMAIL = "privacy-canary@example.com";
const NAME = "Pii Canary";
const REASON_WITH_PII = "forged by john.doe@victim.example.com — please revoke immediately";

function captureDB(handlers) {
    const captured = { auditInserts: [] };
    const db = {
        prepare(sql) {
            let binds = [];
            const rule = handlers.find(r => r.match.test(sql));
            return {
                bind(...args) { binds = args; return this; },
                first: async () => rule?.handler(sql, binds, captured).first ?? null,
                all: async () => ({ results: rule?.handler(sql, binds, captured).all ?? [] }),
                run: async () => {
                    if (/INSERT INTO audit_log/.test(sql)) {
                        // after_json is one of the binds; capture it for assertion
                        captured.auditInserts.push(binds);
                    }
                    return rule?.handler(sql, binds, captured).run ?? { meta: {} };
                },
            };
        },
    };
    return { db, captured };
}

const kvPermissive = { get: async () => null, put: async () => {} };

function json_binds(binds) {
    // audit INSERT carries before_json and after_json as separate string
    // params. Return a joined view so PII in EITHER field trips the assertion.
    return binds
        .filter(b => typeof b === "string" && b.startsWith("{"))
        .join("|");
}

test("register: audit row contains email_sha256, never email_lower", async () => {
    const { db, captured } = captureDB([
        { match: /FROM users WHERE lower\(email\)/, handler: () => ({ first: null }) },
        { match: /FROM users WHERE verification_code/, handler: () => ({ first: null }) },
        { match: /INSERT INTO users/, handler: () => ({ run: {} }) },
        { match: /FROM audit_log ORDER BY ts DESC/, handler: () => ({ first: null }) },
        { match: /INSERT INTO audit_log/, handler: () => ({ run: {} }) },
        { match: /INSERT INTO email_outbox/, handler: () => ({ run: {} }) },
    ]);
    await registerPost({
        env: { DB: db, RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/register`, {
            method: "POST",
            body: JSON.stringify({ email: EMAIL, legal_name: NAME,
                legal_name_attested: true, tos: true }),
        }),
    });
    assert.equal(captured.auditInserts.length, 1);
    const aj = json_binds(captured.auditInserts[0]);
    assert.ok(aj, "expected an after_json payload");
    assert.ok(!aj.includes(EMAIL), `email must not appear cleartext in audit: ${aj}`);
    assert.match(aj, /"email_sha256":"[0-9a-f]{64}"/);
    assert.equal(/"email_lower"/.test(aj), false, "legacy email_lower key must be gone");
});

test("recover: audit row contains email_sha256, never email_lower", async () => {
    const { db, captured } = captureDB([
        {
            match: /FROM users WHERE lower\(email\)/,
            handler: () => ({ first: {
                id: FAKE_ULID, email: EMAIL, legal_name: NAME, dashboard_token: FAKE_TOKEN,
            }}),
        },
        { match: /INSERT INTO email_outbox/, handler: () => ({ run: {} }) },
        { match: /FROM audit_log ORDER BY ts DESC/, handler: () => ({ first: null }) },
        { match: /INSERT INTO audit_log/, handler: () => ({ run: {} }) },
    ]);
    await recoverPost({
        env: { DB: db, RATE_KV: kvPermissive },
        request: new Request(`${BASE}/api/recover`, {
            method: "POST", headers: { Origin: BASE },
            body: JSON.stringify({ email: EMAIL }),
        }),
    });
    assert.equal(captured.auditInserts.length, 1);
    const aj = json_binds(captured.auditInserts[0]);
    assert.ok(!aj.includes(EMAIL), `email leaked into audit: ${aj}`);
    assert.match(aj, /"email_sha256":"[0-9a-f]{64}"/);
});

test("admin/users search: audit row hashes query, drops raw text", async () => {
    const SENSITIVE_Q = "john.doe@victim.example.com";
    const { db, captured } = captureDB([
        { match: /FROM users u[\s\S]*lower\(u\.email\) LIKE/, handler: () => ({ all: [] }) },
        { match: /FROM audit_log ORDER BY ts DESC/, handler: () => ({ first: null }) },
        { match: /INSERT INTO audit_log/, handler: () => ({ run: {} }) },
    ]);
    await usersGet({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/users?q=${encodeURIComponent(SENSITIVE_Q)}`, {
            headers: { Authorization: "Bearer adm" },
        }),
    });
    assert.equal(captured.auditInserts.length, 1);
    const aj = json_binds(captured.auditInserts[0]);
    assert.ok(!aj.includes(SENSITIVE_Q), `raw query leaked: ${aj}`);
    assert.ok(!aj.includes("victim"), "partial PII must not survive hash step");
    assert.match(aj, /"query_sha256":"[0-9a-f]{64}"/);
    assert.match(aj, /"query_length":\d+/);
});

test("admin/revoke: audit row classifies reason, never stores cleartext", async () => {
    const { db, captured } = captureDB([
        {
            match: /FROM certs WHERE public_token/,
            handler: () => ({ first: {
                id: "cert-1", state: "generated", revoked_at: null,
                revocation_reason: null, user_id: FAKE_ULID, period_yyyymm: "202604",
            }}),
        },
        { match: /UPDATE certs[\s\S]+SET state = 'revoked'/, handler: () => ({ run: {} }) },
        { match: /FROM audit_log ORDER BY ts DESC/, handler: () => ({ first: null }) },
        { match: /INSERT INTO audit_log/, handler: () => ({ run: {} }) },
    ]);
    await revokePost({
        env: { DB: db, ADMIN_TOKEN: "adm" },
        request: new Request(`${BASE}/api/admin/revoke`, {
            method: "POST",
            headers: { Authorization: "Bearer adm", "Content-Type": "application/json" },
            body: JSON.stringify({
                public_token: "p".repeat(64),
                reason: REASON_WITH_PII,
            }),
        }),
    });
    assert.equal(captured.auditInserts.length, 1);
    const aj = json_binds(captured.auditInserts[0]);
    assert.ok(!aj.includes("victim.example.com"),
        `revocation reason leaked PII into audit: ${aj}`);
    assert.ok(!aj.includes("john.doe"), "revocation reason still has PII");
    assert.match(aj, /"revocation_class":"issued_in_error"/);
    assert.match(aj, /"revocation_reason_sha256":"[0-9a-f]{64}"/);
    assert.match(aj, /"revocation_reason_length":\d+/);
});
