import { json, clientIp, ipHash, rateLimit } from "../../_lib.js";

export async function onRequestGet({ params, env, request }) {
    const token = params.token;
    if (!token || token.length < 32) return json({ error: "invalid_token" }, 400);

    // Per-IP rate limit on dashboard reads. Without this an attacker who
    // knows the token-charset and length can grind through guesses against
    // /api/me; even with 64-hex tokens the floor on probing rate matters
    // for any future shorter-token migration. 600/hr is well above any
    // legitimate dashboard polling cadence (30s = 120/hr at the busy end).
    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, `me_get:${ipH}`, 600);
    if (!rl.ok) return json(rl.body, rl.status);

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

    // Appeals in any state — the dashboard calendar marks the claimed_date
    // with a badge so the user sees their open/granted/denied claims
    // alongside credited days.
    const appeals = await env.DB.prepare(`
        SELECT id, claimed_date, state, created_at, resolved_at
          FROM appeals WHERE user_id = ?1
       ORDER BY created_at DESC
    `).bind(user.id).all();

    const totalCpe = (attendance.results || []).reduce((s, r) => s + r.earned_cpe, 0);

    // Near-real-time "credited today" signal. Poller writes attendance the
    // moment a qualifying message is seen; this join lets the dashboard show
    // a green check within one poller tick instead of waiting for month-end.
    // today = the most recent stream row (the poller only runs one per day,
    // so "most recent non-complete" is the live one and "most recent complete"
    // is today's that already ended — both cases the user cares about).
    const liveToday = await env.DB.prepare(`
        SELECT s.id AS stream_id, s.yt_video_id, s.title, s.state,
               s.scheduled_date, s.actual_start_at, s.actual_end_at,
               CASE WHEN EXISTS (
                   SELECT 1 FROM attendance a
                    WHERE a.user_id = ?1 AND a.stream_id = s.id
               ) THEN 1 ELSE 0 END AS credited
          FROM streams s
         WHERE s.state IN ('live','complete')
      ORDER BY COALESCE(s.actual_start_at, s.created_at) DESC
         LIMIT 1
    `).bind(user.id).first();

    // Surface the code lifecycle without the value itself. The verification
    // code is delivered via email exactly once at registration; if the user
    // lost it they should hit /api/me/[token]/resend-code rather than read
    // it off the dashboard. This way a casually-shared dashboard URL can't
    // be used to hijack the YouTube-channel binding by posting the code in
    // chat from someone else's account.
    let codeState = "none";
    if (user.verification_code && user.code_expires_at) {
        codeState = new Date(user.code_expires_at).getTime() > Date.now()
            ? "active" : "expired";
    }

    return json({
        user: {
            legal_name: user.legal_name,
            email: user.email,
            yt_channel_id: user.yt_channel_id,
            yt_display_name_seen: user.yt_display_name_seen,
            state: user.state,
            code_state: codeState,
            code_expires_at: user.code_expires_at,
            created_at: user.created_at,
            verified_at: user.verified_at,
        },
        attendance: attendance.results || [],
        certs: certs.results || [],
        appeals: appeals.results || [],
        total_cpe_earned: totalCpe,
        today: liveToday ? {
            stream_id: liveToday.stream_id,
            yt_video_id: liveToday.yt_video_id,
            title: liveToday.title,
            state: liveToday.state,
            scheduled_date: liveToday.scheduled_date,
            actual_start_at: liveToday.actual_start_at,
            actual_end_at: liveToday.actual_end_at,
            credited: !!liveToday.credited,
        } : null,
    });
}
