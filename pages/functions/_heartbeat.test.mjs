// Unit tests for the heartbeat staleness predicate. These pin the
// on-duty logic (poller only during ET window) and the stale threshold
// (>2× expected cadence), which together drive the admin alarm and the
// daily digest's "stale heartbeats" section.
//
// Run: node --test pages/functions/_heartbeat.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    EXPECTED_CADENCE_S, inPollerWindow, onDuty,
    classifyHeartbeat, classifyAll,
} from "./_heartbeat.js";

const WINDOW_ENV = {
    POLL_WINDOW_TZ: "America/New_York",
    POLL_WINDOW_START_HOUR: "8",
    POLL_WINDOW_END_HOUR: "11",
    POLL_WINDOW_DAYS: "1,2,3,4,5",
};

// 2026-04-15 is a Wednesday. 13:30 UTC = 09:30 ET (inside window).
const IN_WINDOW = new Date("2026-04-15T13:30:00Z");
// 2026-04-15 03:30 UTC = 23:30 ET Tue (outside window).
const OFF_WINDOW = new Date("2026-04-15T03:30:00Z");
// 2026-04-18 is a Saturday.
const WEEKEND_IN_HOUR = new Date("2026-04-18T13:30:00Z");

test("inPollerWindow: weekday ET 09:30 → true", () => {
    assert.equal(inPollerWindow(IN_WINDOW, WINDOW_ENV), true);
});

test("inPollerWindow: weekday ET 23:30 → false", () => {
    assert.equal(inPollerWindow(OFF_WINDOW, WINDOW_ENV), false);
});

test("inPollerWindow: weekend inside hour band → false", () => {
    assert.equal(inPollerWindow(WEEKEND_IN_HOUR, WINDOW_ENV), false);
});

test("inPollerWindow: missing env vars → false (fail-safe)", () => {
    assert.equal(inPollerWindow(IN_WINDOW, {}), false);
});

test("onDuty: poller follows window", () => {
    assert.equal(onDuty("poller", IN_WINDOW, WINDOW_ENV), true);
    assert.equal(onDuty("poller", OFF_WINDOW, WINDOW_ENV), false);
});

test("onDuty: continuous sources always on duty", () => {
    for (const s of ["purge", "security_alerts", "email_sender", "canary"]) {
        assert.equal(onDuty(s, OFF_WINDOW, WINDOW_ENV), true, s);
    }
});

test("classifyHeartbeat: fresh beat → not stale", () => {
    const now = IN_WINDOW;
    const beat = new Date(now.getTime() - 60_000).toISOString();  // 60s old
    const r = classifyHeartbeat(
        { source: "poller", last_beat_at: beat, last_status: "ok" },
        now, WINDOW_ENV,
    );
    assert.equal(r.stale, false);
    assert.equal(r.on_duty, true);
    assert.equal(r.expected_s, 120);
    assert.ok(r.age_seconds >= 59 && r.age_seconds <= 61);
});

test("classifyHeartbeat: poller >2× cadence → stale when on duty", () => {
    const now = IN_WINDOW;
    const beat = new Date(now.getTime() - 300_000).toISOString();  // 5 min
    const r = classifyHeartbeat(
        { source: "poller", last_beat_at: beat, last_status: "ok" },
        now, WINDOW_ENV,
    );
    assert.equal(r.stale, true);
});

test("classifyHeartbeat: poller silent off-duty → NOT stale", () => {
    const now = OFF_WINDOW;
    const beat = new Date(now.getTime() - 48 * 3600_000).toISOString();
    const r = classifyHeartbeat(
        { source: "poller", last_beat_at: beat, last_status: "ok" },
        now, WINDOW_ENV,
    );
    assert.equal(r.on_duty, false);
    assert.equal(r.stale, false);
});

test("classifyHeartbeat: email_sender 11 min silent → stale (2×300s = 600s)", () => {
    const now = IN_WINDOW;
    const beat = new Date(now.getTime() - 660_000).toISOString();
    const r = classifyHeartbeat(
        { source: "email_sender", last_beat_at: beat, last_status: "ok" },
        now, WINDOW_ENV,
    );
    assert.equal(r.stale, true);
});

test("classifyHeartbeat: email_sender 9 min silent → NOT stale (under 2×)", () => {
    const now = IN_WINDOW;
    const beat = new Date(now.getTime() - 9 * 60_000).toISOString();
    const r = classifyHeartbeat(
        { source: "email_sender", last_beat_at: beat, last_status: "ok" },
        now, WINDOW_ENV,
    );
    assert.equal(r.stale, false);
});

test("classifyHeartbeat: unknown source → expected_s null, stale false", () => {
    const now = IN_WINDOW;
    const beat = new Date(now.getTime() - 48 * 3600_000).toISOString();
    const r = classifyHeartbeat(
        { source: "mystery_cron", last_beat_at: beat, last_status: "ok" },
        now, WINDOW_ENV,
    );
    assert.equal(r.expected_s, null);
    assert.equal(r.stale, false);
});

test("classifyAll: missing known source surfaces as stale when on duty", () => {
    const rows = [];  // no heartbeats at all
    const result = classifyAll(rows, IN_WINDOW, WINDOW_ENV);
    const byName = Object.fromEntries(result.map(r => [r.source, r]));
    assert.equal(byName.purge.stale, true, "purge missing + on duty = stale");
    assert.equal(byName.email_sender.stale, true);
    assert.equal(byName.poller.stale, true, "poller missing + in-window = stale");
});

test("classifyAll: missing poller off-duty → NOT stale (silence expected)", () => {
    const result = classifyAll([], OFF_WINDOW, WINDOW_ENV);
    const poller = result.find(r => r.source === "poller");
    assert.equal(poller.on_duty, false);
    assert.equal(poller.stale, false);
});

test("classifyAll: covers all declared cadences", () => {
    const names = Object.keys(EXPECTED_CADENCE_S);
    const result = classifyAll([], IN_WINDOW, WINDOW_ENV);
    for (const n of names) {
        assert.ok(result.find(r => r.source === n), `missing ${n} in output`);
    }
});
