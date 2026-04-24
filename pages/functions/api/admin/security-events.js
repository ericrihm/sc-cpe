import { json, isAdmin } from "../../_lib.js";

const EVENT_PREFIXES = [
    "rl_trip:register",
    "rl_trip:recover",
    "rl_trip:preflight_channel_ip",
    "rl_trip:preflight_channel_ch",
    "rl_trip:verify",
    "rl_trip:badge",
    "rl_trip:links",
    "rl_trip:leaderboard",
    "rl_trip:me_get",
    "rl_trip:resend_code",
    "rl_trip:appeal",
    "rl_trip:cert_feedback",
    "rl_trip:cert_per_session",
    "rl_trip:delete",
    "rl_trip:admin_login",
    "auth_fail:bearer",
    "csp_violation",
];

export async function onRequestGet({ request, env }) {
    if (!await isAdmin(env, request)) {
        return json({ error: "unauthorized" }, 401);
    }

    const now = new Date();
    const hours = [];
    for (let i = 0; i < 24; i++) {
        const d = new Date(now.getTime() - i * 3600_000);
        hours.push(d.toISOString().slice(0, 13));
    }

    const events = {};
    let totalTrips = 0;

    for (const prefix of EVENT_PREFIXES) {
        const hourly = [];
        let sum = 0;
        for (const h of hours) {
            const key = `sec:${prefix}:${h}`;
            const val = parseInt(await env.RATE_KV.get(key), 10) || 0;
            hourly.push({ hour: h, count: val });
            sum += val;
        }
        if (sum > 0) {
            events[prefix] = { total_24h: sum, hourly };
            totalTrips += sum;
        }
    }

    const killStates = {};
    for (const sw of ["register", "recover", "preflight"]) {
        killStates[sw] = !!(await env.RATE_KV.get(`kill:${sw}`));
    }

    return json({
        total_events_24h: totalTrips,
        events,
        kill_switches: killStates,
        checked_at: now.toISOString(),
    });
}
