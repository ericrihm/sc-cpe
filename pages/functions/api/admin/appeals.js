import { json, isAdmin } from "../../_lib.js";

// GET /api/admin/appeals[?state=open&limit=50]
// Auth: Authorization: Bearer <ADMIN_TOKEN>
//
// Lists appeals, newest first. Default state=open (the queue).
// Joins users + streams so the admin UI can render the row without
// chasing N+1 lookups.
export async function onRequestGet({ request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }
    const url = new URL(request.url);
    const state = url.searchParams.get("state") || "open";
    if (!["open", "granted", "denied", "cancelled", "any"].includes(state)) {
        return json({ error: "invalid_state" }, 400);
    }
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 200);

    const where = state === "any" ? "" : "WHERE a.state = ?1";
    const binds = state === "any" ? [limit] : [state, limit];
    const sql = `
        SELECT a.id, a.user_id, a.claimed_date, a.claimed_stream_id,
               a.approx_msg_time, a.yt_display_name_used, a.evidence_text,
               a.evidence_url, a.state, a.resolution_notes, a.resolved_by,
               a.resolved_at, a.created_at,
               u.email, u.legal_name, u.yt_channel_id, u.state AS user_state,
               s.yt_video_id, s.title AS stream_title, s.scheduled_date
          FROM appeals a
          JOIN users u ON u.id = a.user_id
     LEFT JOIN streams s ON s.id = a.claimed_stream_id
          ${where}
      ORDER BY a.created_at DESC
         LIMIT ?${state === "any" ? "1" : "2"}
    `;
    const { results = [] } = await env.DB.prepare(sql).bind(...binds).all();
    return json({ ok: true, count: results.length, appeals: results });
}
