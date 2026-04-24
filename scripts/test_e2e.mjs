// End-to-end integration test: register -> attend -> cert -> verify
//
// Exercises the full SC-CPE pipeline using handler-level mocks.
// Run: node --test scripts/test_e2e.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { onRequestPost as registerPost } from "../pages/functions/api/register.js";
import { onRequestGet as meGet } from "../pages/functions/api/me/[token].js";
import { onRequestGet as verifyGet } from "../pages/functions/api/verify/[token].js";

// ── helpers ──────────────────────────────────────────────────────────────

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

const kvPermissive = { get: async () => null, put: async () => {} };

function req(url, { method = "GET", headers = {}, body } = {}) {
    return new Request(url, {
        method,
        headers: { Origin: new URL(url).origin, ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
}

// ── stable fake IDs ──────────────────────────────────────────────────────

const FAKE_ULID = "01HZ99AABBCCDDEEFFGGHH0001";
const FAKE_TOKEN = "a".repeat(64);
const FAKE_BADGE_TOKEN = "b".repeat(64);
const FAKE_PUBLIC_TOKEN = "c".repeat(64);
const FAKE_CERT_ID = "cert-0001";
const BASE = "https://sc-cpe-web.pages.dev";

// ── shared mock rules ────────────────────────────────────────────────────

const auditRules = [
    { match: /FROM audit_log ORDER BY ts DESC/, handler: () => ({ first: null }) },
    { match: /INSERT INTO audit_log/, handler: () => ({ run: { meta: {} } }) },
];

const emailOutboxRule = {
    match: /INSERT INTO email_outbox/,
    handler: () => ({ run: { meta: {} } }),
};

// Full user object for meGet mock
const activeUser = {
    id: FAKE_ULID, email: "alice@example.com",
    legal_name: "Alice Example", yt_channel_id: "UC_FAKE",
    yt_display_name_seen: "Alice", verification_code: null,
    code_expires_at: null, state: "active", email_prefs: "{}",
    show_on_leaderboard: 0, badge_token: FAKE_BADGE_TOKEN,
    created_at: "2026-04-01T00:00:00Z", verified_at: "2026-04-01T01:00:00Z",
    current_streak: 0, longest_streak: 0, last_attendance_date: null,
};

// Cert object for verifyGet mock
const certRow = {
    id: FAKE_CERT_ID, public_token: FAKE_PUBLIC_TOKEN,
    period_yyyymm: "202604", period_start: "2026-04-01",
    period_end: "2026-04-30", cpe_total: 0.5, sessions_count: 1,
    issuer_name_snapshot: "Simply Cyber",
    recipient_name_snapshot: "Alice Example",
    signing_cert_sha256: "deadbeef", pdf_sha256: "cafef00d",
    state: "generated", revocation_reason: null,
    revoked_at: null, generated_at: "2026-04-30T12:00:00Z",
};

// ── Golden path ──────────────────────────────────────────────────────────

describe("E2E: register -> attend -> cert -> verify", () => {

    test("register a new user -> 200, must NOT leak dashboard_token", async () => {
        const db = mockDB([
            { match: /FROM users WHERE lower\(email\)/, handler: () => ({ first: null }) },
            { match: /FROM users WHERE verification_code/, handler: () => ({ first: null }) },
            { match: /INSERT INTO users/, handler: () => ({ run: { meta: {} } }) },
            ...auditRules,
            emailOutboxRule,
        ]);
        const r = await registerPost({
            env: { DB: db, RATE_KV: kvPermissive, TURNSTILE_SECRET_KEY: null },
            request: new Request(`${BASE}/api/register`, {
                method: "POST",
                body: JSON.stringify({
                    email: "alice@example.com",
                    legal_name: "Alice Example",
                    legal_name_attested: true,
                    tos: true,
                }),
            }),
        });
        assert.equal(r.status, 200, "register should return 200");
        const j = await r.json();
        assert.ok(j.ok, "response must have ok: true");
        assert.ok(j.email_sent, "must signal email sent");
        assert.equal(j.dashboard_token, undefined, "must NOT leak dashboard_token");
        assert.equal(j.dashboard_url, undefined, "must NOT leak dashboard_url");
        assert.equal(j.verification_code, undefined, "must NOT leak verification_code");
    });

    test("dashboard for active user with no attendance -> 200, empty arrays", async () => {
        const db = mockDB([
            { match: /FROM users WHERE dashboard_token/, handler: () => ({ first: activeUser }) },
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
            params: { token: FAKE_TOKEN },
            env: { DB: db, RATE_KV: kvPermissive },
            request: req(`${BASE}/api/me/${FAKE_TOKEN}`),
        });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.ok(j.user, "must have user object");
        assert.equal(j.user.legal_name, "Alice Example");
        assert.equal(j.user.state, "active");
        assert.deepEqual(j.attendance, [], "attendance must be empty");
        assert.deepEqual(j.certs, [], "certs must be empty");
        assert.equal(j.total_cpe_earned, 0, "total_cpe_earned must be 0");
    });

    test("dashboard after poller credits attendance -> attendance populated, total_cpe = 0.5", async () => {
        const attendanceRow = {
            stream_id: "stream-0001", earned_cpe: 0.5,
            first_msg_at: "2026-04-10T14:05:00Z", rule_version: "v2",
            source: "poll", first_msg_sha256: "abc123",
            credited_at: "2026-04-10T14:05:01Z",
            scheduled_date: "2026-04-10", yt_video_id: "dQw4w9WgXcQ",
            title: "DTB 2026-04-10", actual_start_at: "2026-04-10T14:00:00Z",
        };
        const db = mockDB([
            { match: /FROM users WHERE dashboard_token/, handler: () => ({ first: activeUser }) },
            { match: /FROM attendance a JOIN streams/, handler: () => ({ all: [attendanceRow] }) },
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
            params: { token: FAKE_TOKEN },
            env: { DB: db, RATE_KV: kvPermissive },
            request: req(`${BASE}/api/me/${FAKE_TOKEN}`),
        });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.attendance.length, 1, "should have 1 attendance record");
        assert.equal(j.attendance[0].stream_id, "stream-0001");
        assert.equal(j.attendance[0].earned_cpe, 0.5);
        assert.equal(j.total_cpe_earned, 0.5, "total_cpe_earned must be 0.5");
    });

    test("dashboard after cert generation -> certs array has cert with public_token", async () => {
        const attendanceRow = {
            stream_id: "stream-0001", earned_cpe: 0.5,
            first_msg_at: "2026-04-10T14:05:00Z", rule_version: "v2",
            source: "poll", first_msg_sha256: "abc123",
            credited_at: "2026-04-10T14:05:01Z",
            scheduled_date: "2026-04-10", yt_video_id: "dQw4w9WgXcQ",
            title: "DTB 2026-04-10", actual_start_at: "2026-04-10T14:00:00Z",
        };
        const certForDashboard = {
            id: FAKE_CERT_ID, public_token: FAKE_PUBLIC_TOKEN,
            period_yyyymm: "202604", cpe_total: 0.5, sessions_count: 1,
            state: "generated", cert_kind: "bundled", stream_id: null,
            supersedes_cert_id: null, generated_at: "2026-04-30T12:00:00Z",
            delivered_at: "2026-04-30T12:01:00Z", first_viewed_at: null,
        };
        const db = mockDB([
            { match: /FROM users WHERE dashboard_token/, handler: () => ({ first: activeUser }) },
            { match: /FROM attendance a JOIN streams/, handler: () => ({ all: [attendanceRow] }) },
            { match: /FROM certs WHERE user_id.*state != 'regenerated'/s, handler: () => ({ all: [certForDashboard] }) },
            { match: /FROM email_outbox.*idempotency_key IN/s, handler: () => ({ all: [] }) },
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
            params: { token: FAKE_TOKEN },
            env: { DB: db, RATE_KV: kvPermissive },
            request: req(`${BASE}/api/me/${FAKE_TOKEN}`),
        });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.certs.length, 1, "should have 1 cert");
        assert.equal(j.certs[0].public_token, FAKE_PUBLIC_TOKEN);
        assert.equal(j.certs[0].state, "generated");
        assert.equal(j.certs[0].cpe_total, 0.5);
        assert.equal(j.total_cpe_earned, 0.5);
    });

    test("verify the cert -> valid: true, correct recipient and cpe_total", async () => {
        const db = mockDB([
            { match: /FROM certs c WHERE c\.public_token/, handler: () => ({ first: certRow }) },
            { match: /UPDATE certs SET first_viewed_at/, handler: () => ({ run: {} }) },
            ...auditRules,
        ]);
        const r = await verifyGet({
            params: { token: FAKE_PUBLIC_TOKEN },
            env: { DB: db, RATE_KV: kvPermissive },
            request: req(`${BASE}/api/verify/${FAKE_PUBLIC_TOKEN}`),
        });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.valid, true, "cert must be valid");
        assert.equal(j.recipient, "Alice Example");
        assert.equal(j.cpe_total, 0.5);
        assert.equal(j.issuer, "Simply Cyber");
        assert.equal(j.period_yyyymm, "202604");
        assert.equal(j.sessions_count, 1);
    });

});

// ── Failure paths ────────────────────────────────────────────────────────

test("unknown dashboard token -> 404", async () => {
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({ first: null }) },
    ]);
    const r = await meGet({
        params: { token: FAKE_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req(`${BASE}/api/me/${FAKE_TOKEN}`),
    });
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.equal(j.error, "not_found");
});

test("revoked cert -> valid: false, state: revoked", async () => {
    const revokedCert = {
        ...certRow,
        state: "revoked",
        revocation_reason: "attendance fraud",
        revoked_at: "2026-04-30T18:00:00Z",
    };
    const db = mockDB([
        { match: /FROM certs c WHERE c\.public_token/, handler: () => ({ first: revokedCert }) },
        { match: /UPDATE certs SET first_viewed_at/, handler: () => ({ run: {} }) },
        ...auditRules,
    ]);
    const r = await verifyGet({
        params: { token: FAKE_PUBLIC_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req(`${BASE}/api/verify/${FAKE_PUBLIC_TOKEN}`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.valid, false, "revoked cert must not be valid");
    assert.equal(j.state, "revoked");
    assert.ok(j.revoked_at, "must include revoked_at");
    // Raw revocation reason must not leak
    assert.ok(!JSON.stringify(j).includes("attendance fraud"),
        "must not expose raw revocation reason text");
});
