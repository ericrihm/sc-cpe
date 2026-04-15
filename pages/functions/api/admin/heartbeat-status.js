import { json, isAdmin } from "../../_lib.js";
import { classifyAll } from "../../_heartbeat.js";

// GET /api/admin/heartbeat-status
// Auth: Authorization: Bearer <ADMIN_TOKEN>
//
// Returns one row per known heartbeat source with staleness classification.
// A source is `stale` when it's on duty AND hasn't beat in >2× its expected
// cadence. Missing-but-on-duty sources are also reported stale — that's the
// case we most want to catch (cron never fired). Unknown sources are
// reported without staleness (expected_s=null).
export async function onRequestGet({ request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }

    const { results = [] } = await env.DB.prepare(
        "SELECT source, last_beat_at, last_status, detail_json FROM heartbeats",
    ).all();

    const now = new Date();
    const classified = classifyAll(results, now, env);
    const stale_count = classified.filter(r => r.stale).length;
    return json({
        ok: stale_count === 0,
        now: now.toISOString(),
        stale_count,
        sources: classified,
    });
}
