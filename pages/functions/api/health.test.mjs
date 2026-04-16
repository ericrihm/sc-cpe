// Tests for /api/health. Guards against the silent-dead-source regression
// that the codex launch review surfaced: before 2026-04-16 the endpoint
// reported only poller + purge, so a dead email_sender, security_alerts,
// or canary cron could hide behind a green health page.

import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequest as healthGet } from "./health.js";

const WINDOW_ENV = {
    POLL_WINDOW_TZ: "America/New_York",
    POLL_WINDOW_START_HOUR: "8",
    POLL_WINDOW_END_HOUR: "11",
    POLL_WINDOW_DAYS: "1,2,3,4,5",
};

function dbWith(rows) {
    return {
        prepare(sql) {
            return {
                all: async () => ({ results: rows }),
            };
        },
    };
}

function request() {
    return new Request("https://sc-cpe-web.pages.dev/api/health");
}

test("health: reports every known cron source — poller, purge, email_sender, security_alerts, canary", async () => {
    const r = await healthGet({ env: { DB: dbWith([]), ...WINDOW_ENV }, request: request() });
    assert.equal(r.status, 200);
    const j = await r.json();
    const names = new Set(j.sources.map(s => s.source));
    for (const expected of ["poller", "purge", "email_sender", "security_alerts", "canary"]) {
        assert.ok(names.has(expected), `health.sources must include ${expected}`);
    }
});

test("health: missing heartbeat on an on-duty source → stale:true", async () => {
    // email_sender has no row at all. It's continuously on-duty, so missing = stale.
    const r = await healthGet({ env: { DB: dbWith([]), ...WINDOW_ENV }, request: request() });
    const j = await r.json();
    const es = j.sources.find(s => s.source === "email_sender");
    assert.ok(es, "email_sender must appear");
    assert.equal(es.stale, true, "missing + on-duty must flag stale");
    assert.equal(es.last_beat_at, null);
});

test("health: fresh beat on email_sender → stale:false", async () => {
    const now = new Date();
    const fresh = new Date(now.getTime() - 60_000).toISOString();
    const r = await healthGet({
        env: {
            DB: dbWith([{ source: "email_sender", last_beat_at: fresh, last_status: "ok" }]),
            ...WINDOW_ENV,
        },
        request: request(),
    });
    const j = await r.json();
    const es = j.sources.find(s => s.source === "email_sender");
    assert.equal(es.stale, false);
    assert.equal(es.last_status, "ok");
});

test("health: any_stale rolls up correctly", async () => {
    // Fresh email_sender, everything else missing. Non-poller missing sources
    // (purge, security_alerts, canary) are on-duty continuously → stale.
    const now = new Date();
    const fresh = new Date(now.getTime() - 60_000).toISOString();
    const r = await healthGet({
        env: {
            DB: dbWith([{ source: "email_sender", last_beat_at: fresh, last_status: "ok" }]),
            ...WINDOW_ENV,
        },
        request: request(),
    });
    const j = await r.json();
    assert.equal(j.any_stale, true, "purge/security_alerts/canary missing → any_stale must be true");
});

test("health: watchdog contract — every source has source/stale/last_beat_at/age_seconds fields", async () => {
    // watchdog.yml's jq extracts these four fields per source. Breaking any
    // of them would break alert dedup without the workflow turning red.
    const r = await healthGet({ env: { DB: dbWith([]), ...WINDOW_ENV }, request: request() });
    const j = await r.json();
    for (const s of j.sources) {
        assert.ok("source" in s);
        assert.ok("stale" in s);
        assert.ok("last_beat_at" in s);
        assert.ok("age_seconds" in s);
    }
});
