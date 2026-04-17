// Heartbeat staleness predicate — pure, no I/O. Shared between the admin
// status endpoint and the purge worker's daily digest. The purge worker can't
// import from pages/functions (separate deploys), so it carries a mirrored
// copy at workers/purge/src/heartbeat-staleness.js. Keep the two in sync.
//
// Cadence is expressed as the interval the source is EXPECTED to beat at
// when it's "on duty". A source is `stale` when age > 2× expected AND it's
// currently on duty. The poller is only on duty during the ET poll window;
// silence outside the window is normal, not a failure.

// Expected-cadence seconds per heartbeats.source.
export const EXPECTED_CADENCE_S = {
    poller: 120,            // cron=*/1min, only during ET Mon-Fri 8-11am
    purge: 90000,           // cron=daily 09:00 UTC
    security_alerts: 90000, // piggybacks on purge
    email_sender: 300,      // cron=*/2min continuous
    canary: 3600,           // hourly synthetic smoke
    monthly_digest: 2678400, // ~31 days; fires 1st of month
};

// True when `now` falls inside the poller's ET weekday window. Vars come from
// pages/wrangler.toml and mirror workers/poller/wrangler.toml — same parse
// as poller's inPollWindow(), kept deliberately separate so missing vars
// degrade safely (we return false and skip staleness for poller).
export function inPollerWindow(now, env) {
    const tz = env?.POLL_WINDOW_TZ;
    const start = parseInt(env?.POLL_WINDOW_START_HOUR, 10);
    const end = parseInt(env?.POLL_WINDOW_END_HOUR, 10);
    const daysStr = env?.POLL_WINDOW_DAYS;
    if (!tz || !Number.isFinite(start) || !Number.isFinite(end) || !daysStr) {
        return false;
    }
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false, weekday: "short", hour: "2-digit",
    });
    const p = fmt.formatToParts(now).reduce((o, x) => (o[x.type] = x.value, o), {});
    const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
    const hour = parseInt(p.hour, 10);
    const days = daysStr.split(",").map(Number);
    return days.includes(dow) && hour >= start && hour < end;
}

// Returns whether a source is considered "on duty" at `now`. Sources that
// are continuously on duty (purge, email_sender, security_alerts, canary)
// are always on duty; the poller is only on duty during its window.
export function onDuty(source, now, env) {
    if (source === "poller") return inPollerWindow(now, env);
    return true;
}

// Decide staleness for one heartbeats row. Shape of input mirrors the
// heartbeats table: { source, last_beat_at (ISO), last_status }.
// `now` is a Date; `env` carries the poll-window vars.
// Returns { source, last_beat_at, last_status, age_seconds, expected_s,
//          on_duty, stale }. stale=true iff on_duty AND age > 2×expected.
// For unknown sources expected_s is null and stale=false (don't alarm on
// sources we haven't explicitly classified).
export function classifyHeartbeat(row, now, env) {
    const expected_s = EXPECTED_CADENCE_S[row.source] ?? null;
    const last = row.last_beat_at ? new Date(row.last_beat_at).getTime() : null;
    const age_seconds = last == null ? null
        : Math.max(0, Math.floor((now.getTime() - last) / 1000));
    const on_duty = onDuty(row.source, now, env);
    const stale = expected_s != null
        && age_seconds != null
        && on_duty
        && age_seconds > 2 * expected_s;
    return {
        source: row.source,
        last_beat_at: row.last_beat_at ?? null,
        last_status: row.last_status ?? null,
        age_seconds,
        expected_s,
        on_duty,
        stale,
    };
}

// Convenience: classify every row and also synthesise a "missing" record for
// any known source that has no heartbeats row yet. Missing-but-on-duty
// sources are treated as stale so an unconfigured cron doesn't stay invisible.
export function classifyAll(rows, now, env) {
    const byName = new Map(rows.map(r => [r.source, r]));
    const out = [];
    for (const name of Object.keys(EXPECTED_CADENCE_S)) {
        const row = byName.get(name);
        if (row) {
            out.push(classifyHeartbeat(row, now, env));
        } else {
            const on_duty = onDuty(name, now, env);
            out.push({
                source: name,
                last_beat_at: null,
                last_status: null,
                age_seconds: null,
                expected_s: EXPECTED_CADENCE_S[name],
                on_duty,
                stale: on_duty,  // missing + on duty = stale
            });
        }
    }
    // Include any unknown sources as informational (not stale).
    for (const r of rows) {
        if (!(r.source in EXPECTED_CADENCE_S)) {
            out.push(classifyHeartbeat(r, now, env));
        }
    }
    return out;
}
