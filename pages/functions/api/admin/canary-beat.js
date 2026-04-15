import { json, isAdmin } from "../../_lib.js";

// POST /api/admin/canary-beat
// Auth: Authorization: Bearer <ADMIN_TOKEN>
//
// Writes a heartbeats row with source='canary'. Called by the hourly smoke
// GitHub Action at the end of a successful run — the row is what
// /api/admin/heartbeat-status uses to know the canary is alive. If the
// smoke fails, the action aborts before this runs, the heartbeat ages,
// and the next admin check / digest flags the canary as stale.
export async function onRequestPost({ request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }
    const now = new Date().toISOString();
    const sha = request.headers.get("X-Canary-Sha") || "unknown";
    await env.DB.prepare(`
        INSERT INTO heartbeats (source, last_beat_at, last_status, detail_json)
        VALUES ('canary', ?1, 'ok', ?2)
        ON CONFLICT(source) DO UPDATE SET
            last_beat_at = excluded.last_beat_at,
            last_status  = excluded.last_status,
            detail_json  = excluded.detail_json
    `).bind(now, JSON.stringify({ at: now, sha })).run();
    return json({ ok: true, source: "canary", last_beat_at: now });
}
