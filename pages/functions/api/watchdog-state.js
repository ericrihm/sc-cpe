import { json, constantTimeEqual } from "../_lib.js";

// Alert dedup state for the external GH Actions watchdog. Writing to
// Cloudflare KV lets us be idempotent across runner invocations without
// relying on flaky GH Actions cache.
//
// Shape stored at RATE_KV key `watchdog:alerted`:
//   { [source]: ISO8601_alert_start | null, ... }
// If a source is present with a timestamp, the watchdog has already sent
// a "down" Discord alert and should not re-alert until the source recovers.
// On recovery the watchdog POSTs to clear the entry, optionally sending a
// "recovered" notification.
//
// Both GET and POST require the shared WATCHDOG_SECRET via the
// X-Watchdog-Secret header; the endpoint is otherwise trivially enumerable
// from the outside and we don't want bad actors poisoning dedup state.

const KV_KEY = "watchdog:alerted";

export async function onRequestGet({ request, env }) {
    const auth = await requireSecret(request, env);
    if (auth) return auth;
    const state = (await readState(env)) || {};
    return json({ alerted: state }, 200);
}

export async function onRequestPost({ request, env }) {
    const auth = await requireSecret(request, env);
    if (auth) return auth;

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const source = (body.source || "").trim();
    if (!source || !/^[a-z0-9_:.-]{1,64}$/.test(source)) {
        return json({ error: "invalid_source" }, 400);
    }

    const state = (await readState(env)) || {};
    if (body.clear === true) {
        delete state[source];
    } else {
        state[source] = body.alert_start || new Date().toISOString();
    }
    await writeState(env, state);
    return json({ ok: true, alerted: state }, 200);
}

async function requireSecret(request, env) {
    if (!env.WATCHDOG_SECRET) {
        return json({ error: "watchdog_secret_not_configured" }, 503);
    }
    const provided = request.headers.get("X-Watchdog-Secret") || "";
    if (!await constantTimeEqual(provided, env.WATCHDOG_SECRET)) {
        return json({ error: "unauthorized" }, 401);
    }
    return null;
}

async function readState(env) {
    if (!env.RATE_KV) return {};
    const raw = await env.RATE_KV.get(KV_KEY);
    if (!raw) return {};
    try { return JSON.parse(raw); }
    catch { return {}; }
}

async function writeState(env, state) {
    if (!env.RATE_KV) return;
    await env.RATE_KV.put(KV_KEY, JSON.stringify(state));
}
