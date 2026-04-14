import { json } from "../../_lib.js";

export async function onRequestGet({ params, env }) {
    const token = params.token;
    if (!token || token.length < 32) return json({ error: "invalid_token" }, 400);

    const user = await env.DB.prepare(`
        SELECT id, email, legal_name, yt_channel_id, yt_display_name_seen,
               verification_code, code_expires_at, state, created_at, verified_at
        FROM users WHERE dashboard_token = ?1 AND deleted_at IS NULL
    `).bind(token).first();

    if (!user) return json({ error: "not_found" }, 404);

    const attendance = await env.DB.prepare(`
        SELECT a.stream_id, a.earned_cpe, a.first_msg_at, a.rule_version,
               s.scheduled_date, s.yt_video_id, s.title
        FROM attendance a JOIN streams s ON s.id = a.stream_id
        WHERE a.user_id = ?1
        ORDER BY s.scheduled_date DESC, a.first_msg_at DESC
    `).bind(user.id).all();

    const certs = await env.DB.prepare(`
        SELECT id, public_token, period_yyyymm, cpe_total, sessions_count,
               state, generated_at, delivered_at
        FROM certs WHERE user_id = ?1 ORDER BY period_yyyymm DESC
    `).bind(user.id).all();

    const totalCpe = (attendance.results || []).reduce((s, r) => s + r.earned_cpe, 0);

    return json({
        user: {
            legal_name: user.legal_name,
            email: user.email,
            yt_channel_id: user.yt_channel_id,
            yt_display_name_seen: user.yt_display_name_seen,
            state: user.state,
            verification_code: user.verification_code,
            code_expires_at: user.code_expires_at,
            created_at: user.created_at,
            verified_at: user.verified_at,
        },
        attendance: attendance.results || [],
        certs: certs.results || [],
        total_cpe_earned: totalCpe,
    });
}
