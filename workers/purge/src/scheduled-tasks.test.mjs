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

function authReq(only) {
    return new Request(`https://worker.dev/?only=${only}`, {
        headers: { Authorization: "Bearer adm" },
    });
}

const BASE_ENV = {
    ADMIN_TOKEN: "adm",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "noreply@signalplane.co",
    ADMIN_ALERT_EMAIL: "admin@test.invalid",
    SITE_BASE: "https://sc-cpe-web.pages.dev",
};

// ── security_alerts ───────────────────────────────────────────────────

test("security_alerts: no events, no stale heartbeats → no email sent", async () => {
    let resendCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (url === "https://api.resend.com/emails") {
            resendCalled = true;
            return new Response(JSON.stringify({ id: "msg1" }), { status: 200 });
        }
        return origFetch(url);
    };
    try {
        const db = stubDB({
            "FROM heartbeats WHERE source = 'security_alerts'": () => ({
                detail_json: JSON.stringify({ cursor_ts: "2026-04-24T00:00:00Z" }),
            }),
            "FROM audit_log.*WHERE ts": () => [],
            "FROM heartbeats": () => [
                "purge", "email_sender", "security_alerts", "canary",
                "monthly_digest", "link_enrichment", "cert_nudge", "renewal_nudge",
            ].map(s => ({ source: s, last_beat_at: new Date().toISOString(), last_status: "ok" })),
            "INSERT INTO heartbeats": () => null,
        });
        const r = await handler.fetch(authReq("security_alerts"), { ...BASE_ENV, DB: db });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.security_alerts.events, 0);
        assert.equal(j.security_alerts.stale_heartbeats, 0);
        assert.equal(resendCalled, false);
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("security_alerts: events present → email sent, cursor advanced", async () => {
    let resendCalled = false;
    let sentSubject = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        if (url === "https://api.resend.com/emails") {
            resendCalled = true;
            sentSubject = JSON.parse(opts.body).subject;
            return new Response(JSON.stringify({ id: "msg2" }), { status: 200 });
        }
        return origFetch(url, opts);
    };
    try {
        const db = stubDB({
            "FROM heartbeats WHERE source = 'security_alerts'": () => ({
                detail_json: JSON.stringify({ cursor_ts: "2026-04-23T00:00:00Z" }),
            }),
            "FROM audit_log.*WHERE ts": () => [
                { id: "01EVT", ts: "2026-04-24T10:00:00Z", actor_type: "poller", actor_id: null, action: "code_race_detected", entity_id: "01STREAM", after_json: '{"contested":true}' },
            ],
            "FROM heartbeats": () => [
                { source: "purge", last_beat_at: new Date().toISOString(), last_status: "ok" },
                { source: "email_sender", last_beat_at: new Date().toISOString(), last_status: "ok" },
            ],
            "INSERT INTO heartbeats": () => null,
        });
        const r = await handler.fetch(authReq("security_alerts"), { ...BASE_ENV, DB: db });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.security_alerts.events, 1);
        assert.equal(j.security_alerts.cursor_ts, "2026-04-24T10:00:00Z");
        assert.ok(resendCalled, "should have sent email via Resend");
        assert.ok(sentSubject.includes("1 security event"));
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("security_alerts: missing secrets → skipped", async () => {
    const db = stubDB({ "INSERT INTO heartbeats": () => null });
    const r = await handler.fetch(authReq("security_alerts"), {
        ADMIN_TOKEN: "adm", DB: db,
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.security_alerts.skipped, "missing_secrets");
});

// ── cert_nudge ────────────────────────────────────────────────────────

test("cert_nudge: generated cert with no feedback → email queued", async () => {
    let insertedEmail = null;
    const db = stubDB({
        "FROM certs c.*JOIN users u": () => [{
            cert_id: "01CERT", public_token: "a".repeat(64), period_yyyymm: "202603",
            user_id: "01USER", email: "test@example.com", legal_name: "Test User",
            dashboard_token: "d".repeat(64), email_prefs: "{}",
        }],
        "INSERT INTO email_outbox": (sql, binds) => {
            insertedEmail = binds;
            return { meta: { changes: 1 } };
        },
        "INSERT INTO heartbeats": () => null,
    });
    const r = await handler.fetch(authReq("cert_nudge"), { ...BASE_ENV, DB: db });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.cert_nudge.queued, 1);
    assert.equal(j.cert_nudge.skipped, 0);
    assert.ok(insertedEmail, "should have inserted email into outbox");
});

test("cert_nudge: unsubscribed user → skipped", async () => {
    const db = stubDB({
        "FROM certs c.*JOIN users u": () => [{
            cert_id: "01CERT", public_token: "a".repeat(64), period_yyyymm: "202603",
            user_id: "01USER", email: "test@example.com", legal_name: "Test User",
            dashboard_token: "d".repeat(64),
            email_prefs: JSON.stringify({ unsubscribed: ["cert_nudge"] }),
        }],
        "INSERT INTO heartbeats": () => null,
    });
    const r = await handler.fetch(authReq("cert_nudge"), { ...BASE_ENV, DB: db });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.cert_nudge.queued, 0);
    assert.equal(j.cert_nudge.skipped, 1);
});

test("cert_nudge: no candidates → zero queued", async () => {
    const db = stubDB({
        "FROM certs c.*JOIN users u": () => [],
        "INSERT INTO heartbeats": () => null,
    });
    const r = await handler.fetch(authReq("cert_nudge"), { ...BASE_ENV, DB: db });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.cert_nudge.queued, 0);
    assert.equal(j.cert_nudge.candidates, 0);
});

test("cert_nudge: missing SITE_BASE → skipped", async () => {
    const db = stubDB({ "INSERT INTO heartbeats": () => null });
    const r = await handler.fetch(authReq("cert_nudge"), {
        ADMIN_TOKEN: "adm", DB: db,
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.cert_nudge.skipped, "missing_site_base");
});

// ── weekly_digest ─────────────────────────────────────────────────────

test("weekly_digest: sends digest with stats", async () => {
    let resendCalled = false;
    let sentBody = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        if (url === "https://api.resend.com/emails") {
            resendCalled = true;
            sentBody = JSON.parse(opts.body);
            return new Response(JSON.stringify({ id: "msg3" }), { status: 200 });
        }
        return origFetch(url, opts);
    };
    try {
        const db = stubDB({
            "COUNT.*FROM users WHERE created_at": () => ({ n: 3 }),
            "COUNT.*FROM users WHERE verified_at": () => ({ n: 2 }),
            "COUNT.*FROM attendance WHERE created_at": () => ({ n: 15 }),
            "COUNT.*FROM certs WHERE created_at": () => ({ n: 1 }),
            "COUNT.*FROM appeals WHERE created_at": () => ({ n: 0 }),
            "COUNT.*FROM appeals WHERE resolved_at.*granted": () => ({ n: 0 }),
            "COUNT.*FROM appeals WHERE resolved_at.*denied": () => ({ n: 0 }),
            "COUNT.*FROM email_outbox WHERE sent_at.*sent": () => ({ n: 10 }),
            "COUNT.*FROM email_outbox WHERE state = 'failed'": () => ({ n: 0 }),
            "FROM attendance a.*JOIN streams.*JOIN users.*show_on_leaderboard": () => [
                { legal_name: "Top User", cpe_earned: 5.0, current_streak: 10 },
            ],
            "INSERT INTO heartbeats": () => null,
        });
        const r = await handler.fetch(authReq("weekly_digest"), { ...BASE_ENV, DB: db });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.weekly_digest.sent, true);
        assert.ok(resendCalled, "should have sent email via Resend");
        assert.ok(sentBody.subject.includes("weekly digest"));
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("weekly_digest: missing secrets → skipped", async () => {
    const db = stubDB({ "INSERT INTO heartbeats": () => null });
    const r = await handler.fetch(authReq("weekly_digest"), {
        ADMIN_TOKEN: "adm", DB: db,
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.weekly_digest.skipped, "missing_secrets");
});
