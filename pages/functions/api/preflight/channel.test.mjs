// Tests for GET /api/preflight/channel. Guards the enumeration-oracle
// caps added after codex's pre-launch review: a single IP can only probe
// 20/hour, and any single channel id can only be probed 10/UTC-day across
// all IPs combined.

import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet as preflightGet } from "./channel.js";

const BASE = "https://sc-cpe-web.pages.dev/api/preflight/channel";
const CHANNEL = "UC1234567890abcdefghijkl"; // 22 chars after UC
const DB_EMPTY = {
    prepare() {
        return { bind: () => ({ first: async () => null }) };
    },
};

function req(url) { return new Request(url); }

test("preflight: valid channel id, not taken → {valid:true, available:true}", async () => {
    const kv = { get: async () => null, put: async () => {} };
    const r = await preflightGet({
        env: { DB: DB_EMPTY, RATE_KV: kv },
        request: req(`${BASE}?q=${CHANNEL}`),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.valid, true);
    assert.equal(j.available, true);
    assert.equal(j.normalized, CHANNEL);
});

test("preflight: channel id that is bound → {available:false}", async () => {
    const kv = { get: async () => null, put: async () => {} };
    const db = {
        prepare() {
            return { bind: () => ({ first: async () => ({ id: "01HUSER" }) }) };
        },
    };
    const r = await preflightGet({
        env: { DB: db, RATE_KV: kv },
        request: req(`${BASE}?q=${CHANNEL}`),
    });
    const j = await r.json();
    assert.equal(j.available, false);
    // Must NOT leak which user owns it.
    assert.equal(j.user_id, undefined);
    assert.equal(j.owner, undefined);
});

test("preflight: IP cap (20/hr) trips on the 21st probe from same hashed IP", async () => {
    // KV returns "20" for the IP key — meaning 20 prior successful probes.
    // kill-switch key must be null so we hit the IP-cap branch, not 503.
    const kv = {
        get: async (k) => {
            if (k.startsWith("kill:")) return null;
            return k.startsWith("preflight_channel_ip:") ? "20" : null;
        },
        put: async () => {},
    };
    const r = await preflightGet({
        env: { DB: DB_EMPTY, RATE_KV: kv },
        request: req(`${BASE}?q=${CHANNEL}`),
    });
    assert.equal(r.status, 429);
    const j = await r.json();
    assert.equal(j.error, "rate_limited");
});

test("preflight: per-channel cap (10/day) trips regardless of IP", async () => {
    // IP key fresh, but per-channel key reports 10 — a distributed attacker
    // rotating IPs hits this wall even though their individual IP counter
    // is low.
    const kv = {
        get: async (k) => {
            if (k.startsWith("kill:")) return null;
            if (k.startsWith("preflight_channel_ip:")) return "0";
            if (k.startsWith("preflight_channel_ch:")) return "10";
            return null;
        },
        put: async () => {},
    };
    const r = await preflightGet({
        env: { DB: DB_EMPTY, RATE_KV: kv },
        request: req(`${BASE}?q=${CHANNEL}`),
    });
    assert.equal(r.status, 429);
});

test("preflight: malformed input returns 400 BEFORE touching per-channel cap", async () => {
    const puts = [];
    // get() returns "0" for counter keys, null for kill-switch keys. "0" is
    // truthy as a string in JS — if kill-switch keys returned "0" the
    // killSwitched() check would false-positive and we'd 503 instead of 400.
    const kv = {
        get: async (k) => k.startsWith("kill:") ? null : "0",
        put: async (k) => { puts.push(k); },
    };
    const r = await preflightGet({
        env: { DB: DB_EMPTY, RATE_KV: kv },
        request: req(`${BASE}?q=not-a-channel`),
    });
    assert.equal(r.status, 400);
    // IP cap was touched (unavoidable), but per-channel should NOT be —
    // otherwise sending garbage input would burn the daily cap for
    // non-existent channel ids.
    assert.equal(puts.some(k => k.startsWith("preflight_channel_ch:")), false,
        "per-channel KV write must not happen when input is malformed");
});

test("preflight: kill switch set → 503 with admin_kill_switch reason", async () => {
    const killed = { get: async (k) => k === "kill:preflight" ? "1" : null, put: async () => {} };
    const r = await preflightGet({
        env: { DB: DB_EMPTY, RATE_KV: killed },
        request: req(`${BASE}?q=${CHANNEL}`),
    });
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.error, "service_temporarily_unavailable");
    assert.equal(j.reason, "admin_kill_switch");
});

test("preflight: missing RATE_KV → 503 (fail-closed)", async () => {
    const r = await preflightGet({
        env: { DB: DB_EMPTY /* no RATE_KV */ },
        request: req(`${BASE}?q=${CHANNEL}`),
    });
    assert.equal(r.status, 503);
});
