import { json } from "../_lib.js";

// Public liveness endpoint the external watchdog polls every 15 min.
// Reveals heartbeat ages + per-source `stale` bool; no PII, no credentials,
// so no auth required. The `stale` flag is evaluated against each source's
// expected cadence:
//   - poller: expected to beat at least once every ~5 min while inside the
//     ET weekday poll window; outside the window silence is normal.
//   - purge : expected to beat once per ~24h; alert if >26h silent.
//
// Watchdog logic for alert suppression lives in /api/watchdog-state.

const POLLER_STALE_SECONDS = 300;   // 5 min of silence inside the poll window
const PURGE_STALE_SECONDS = 26 * 3600;

export async function onRequest({ request, env }) {
    const now = new Date();
    const windowActive = inPollWindow(now, env);

    const rows = await env.DB.prepare(
        "SELECT source, last_beat_at, last_status, detail_json FROM heartbeats"
    ).all();
    const bySource = new Map();
    for (const r of rows.results || []) bySource.set(r.source, r);

    const sources = [
        buildSourceStatus("poller", bySource.get("poller"), now, {
            expected: windowActive,
            stale_seconds: POLLER_STALE_SECONDS,
        }),
        buildSourceStatus("purge", bySource.get("purge"), now, {
            expected: true,
            stale_seconds: PURGE_STALE_SECONDS,
        }),
    ];

    const anyStale = sources.some(s => s.stale);

    return json({
        now: now.toISOString(),
        poll_window_active: windowActive,
        any_stale: anyStale,
        sources,
    }, 200);
}

function buildSourceStatus(source, row, now, { expected, stale_seconds }) {
    if (!row) {
        return {
            source,
            last_beat_at: null,
            last_status: null,
            age_seconds: null,
            expected,
            stale: expected,  // no heartbeat at all + expected = definitely stale
            threshold_seconds: stale_seconds,
        };
    }
    const last = new Date(row.last_beat_at);
    const age = Math.floor((now - last) / 1000);
    const stale = expected && (age > stale_seconds || row.last_status === "error");
    return {
        source,
        last_beat_at: row.last_beat_at,
        last_status: row.last_status,
        age_seconds: age,
        expected,
        stale,
        threshold_seconds: stale_seconds,
    };
}

function inPollWindow(now, env) {
    const tz = env.POLL_WINDOW_TZ || "America/New_York";
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        weekday: "short",
        hour: "2-digit",
    });
    const p = fmt.formatToParts(now).reduce((o, x) => (o[x.type] = x.value, o), {});
    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = dowMap[p.weekday];
    const hour = parseInt(p.hour, 10);
    const days = (env.POLL_WINDOW_DAYS || "1,2,3,4,5").split(",").map(Number);
    const start = parseInt(env.POLL_WINDOW_START_HOUR || "8", 10);
    const end = parseInt(env.POLL_WINDOW_END_HOUR || "11", 10);
    return days.includes(dow) && hour >= start && hour < end;
}
