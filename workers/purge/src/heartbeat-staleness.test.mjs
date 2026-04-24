// Tests the purge worker's stale-heartbeats predicate. This mirrors the
// pages/functions/_heartbeat.js predicate but is kept separate (the purge
// worker is a separate deploy). If these tests diverge in behaviour from
// pages/functions/_heartbeat.test.mjs, the digest and the admin UI will
// disagree on what's stale.
//
// Run: node --test workers/purge/src/heartbeat-staleness.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { staleHeartbeats } from "./index.js";

const NOW_MS = Date.parse("2026-04-15T09:00:00Z");  // digest time

function ago(s) { return new Date(NOW_MS - s * 1000).toISOString(); }

test("staleHeartbeats: empty table → every known non-poller source stale", () => {
    const out = staleHeartbeats([], NOW_MS);
    const sources = out.map(r => r.source).sort();
    assert.deepEqual(sources, ["canary", "cert_nudge", "email_sender", "link_enrichment", "monthly_digest", "purge", "renewal_nudge", "security_alerts"]);
    assert.ok(out.every(r => r.reason === "never_beat"));
});

test("staleHeartbeats: fresh beats → none stale", () => {
    const rows = [
        { source: "purge", last_beat_at: ago(3600), last_status: "ok" },
        { source: "security_alerts", last_beat_at: ago(3600), last_status: "ok" },
        { source: "email_sender", last_beat_at: ago(60), last_status: "ok" },
        { source: "canary", last_beat_at: ago(600), last_status: "ok" },
        { source: "monthly_digest", last_beat_at: ago(86400), last_status: "ok" },
        { source: "link_enrichment", last_beat_at: ago(3600), last_status: "ok" },
        { source: "cert_nudge", last_beat_at: ago(86400), last_status: "ok" },
        { source: "renewal_nudge", last_beat_at: ago(3600), last_status: "ok" },
    ];
    assert.deepEqual(staleHeartbeats(rows, NOW_MS), []);
});

test("staleHeartbeats: email_sender 11 min old → stale", () => {
    const rows = [
        { source: "purge", last_beat_at: ago(3600), last_status: "ok" },
        { source: "security_alerts", last_beat_at: ago(3600), last_status: "ok" },
        { source: "email_sender", last_beat_at: ago(660), last_status: "ok" },
        { source: "canary", last_beat_at: ago(600), last_status: "ok" },
        { source: "monthly_digest", last_beat_at: ago(86400), last_status: "ok" },
        { source: "link_enrichment", last_beat_at: ago(3600), last_status: "ok" },
        { source: "cert_nudge", last_beat_at: ago(86400), last_status: "ok" },
        { source: "renewal_nudge", last_beat_at: ago(3600), last_status: "ok" },
    ];
    const out = staleHeartbeats(rows, NOW_MS);
    assert.equal(out.length, 1);
    assert.equal(out[0].source, "email_sender");
    assert.equal(out[0].reason, "age_exceeds_2x");
});

test("staleHeartbeats: poller excluded regardless of staleness", () => {
    // Poller silence is expected at digest time (09:00 UTC ~= 05:00 ET).
    const rows = [
        { source: "poller", last_beat_at: ago(48 * 3600), last_status: "ok" },
        { source: "purge", last_beat_at: ago(3600), last_status: "ok" },
        { source: "security_alerts", last_beat_at: ago(3600), last_status: "ok" },
        { source: "email_sender", last_beat_at: ago(60), last_status: "ok" },
        { source: "canary", last_beat_at: ago(600), last_status: "ok" },
        { source: "monthly_digest", last_beat_at: ago(86400), last_status: "ok" },
        { source: "link_enrichment", last_beat_at: ago(3600), last_status: "ok" },
        { source: "cert_nudge", last_beat_at: ago(86400), last_status: "ok" },
        { source: "renewal_nudge", last_beat_at: ago(3600), last_status: "ok" },
    ];
    assert.deepEqual(staleHeartbeats(rows, NOW_MS), []);
});

test("staleHeartbeats: unknown source ignored", () => {
    const rows = [
        { source: "purge", last_beat_at: ago(3600), last_status: "ok" },
        { source: "security_alerts", last_beat_at: ago(3600), last_status: "ok" },
        { source: "email_sender", last_beat_at: ago(60), last_status: "ok" },
        { source: "canary", last_beat_at: ago(600), last_status: "ok" },
        { source: "monthly_digest", last_beat_at: ago(86400), last_status: "ok" },
        { source: "link_enrichment", last_beat_at: ago(3600), last_status: "ok" },
        { source: "cert_nudge", last_beat_at: ago(86400), last_status: "ok" },
        { source: "renewal_nudge", last_beat_at: ago(3600), last_status: "ok" },
        { source: "mystery_cron", last_beat_at: ago(7 * 86400), last_status: "ok" },
    ];
    assert.deepEqual(staleHeartbeats(rows, NOW_MS), []);
});
