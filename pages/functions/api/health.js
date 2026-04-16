import { json } from "../_lib.js";
import { classifyAll, inPollerWindow } from "../_heartbeat.js";

// Public liveness endpoint the external watchdog polls every 15 min.
// Reveals heartbeat ages + per-source `stale` bool; no PII, no credentials,
// so no auth required.
//
// Delegates to the shared _heartbeat classifier so every known cron source
// (poller, purge, email_sender, security_alerts, canary) is reported and
// alerted on consistently. Previously this endpoint only checked poller
// and purge, which let a dead email_sender or security_alerts digest
// hide behind a green `/api/health` — see codex launch review 2026-04-16.
//
// Watchdog logic for alert suppression lives in /api/watchdog-state.

export async function onRequest({ request, env }) {
    const now = new Date();
    const { results = [] } = await env.DB.prepare(
        "SELECT source, last_beat_at, last_status FROM heartbeats"
    ).all();

    const classified = classifyAll(results, now, env);

    const sources = classified.map(s => ({
        source: s.source,
        last_beat_at: s.last_beat_at,
        last_status: s.last_status,
        age_seconds: s.age_seconds,
        expected: s.on_duty,
        stale: s.stale,
        // Exposing threshold lets the watchdog + operators see exactly what
        // triggered a stale flag. classifyAll considers a source stale when
        // age > 2×expected, so the effective threshold is 2×expected_s.
        threshold_seconds: s.expected_s != null ? s.expected_s * 2 : null,
    }));

    return json({
        now: now.toISOString(),
        poll_window_active: inPollerWindow(now, env),
        any_stale: sources.some(s => s.stale),
        sources,
    }, 200);
}
