import { json, isAdmin, rateLimit, clientIp, ipHash } from "../../_lib.js";

export async function onRequestGet({ request, env }) {
    if (!(await isAdmin(env, request))) return json({ error: "unauthorized" }, 401);

    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, `admin_streams:${ipH}`, 60);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    const url = new URL(request.url);
    const daysParam = parseInt(url.searchParams.get("days"), 10);
    const days = (daysParam > 0 && daysParam <= 365) ? daysParam : 30;

    const rows = await env.DB.prepare(
        `SELECT id, yt_video_id, title, scheduled_date, state, actual_start_at, actual_end_at,
                (SELECT COUNT(*) FROM attendance a WHERE a.stream_id = s.id) AS attendance_count
         FROM streams s
         WHERE scheduled_date >= date('now', '-' || ?1 || ' days')
         ORDER BY scheduled_date DESC
         LIMIT 100`
    ).bind(days).all();

    return json({ ok: true, streams: rows.results || [] });
}
