import { json, clientIp, ipHash, rateLimit, isValidToken } from "../../_lib.js";

export async function onRequestGet({ params, env, request }) {
    const token = params.token;
    if (!isValidToken(token)) return json({ error: "invalid_token" }, 400);

    // Per-IP rate limit on dashboard reads. Without this an attacker who
    // knows the token-charset and length can grind through guesses against
    // /api/me; even with 64-hex tokens the floor on probing rate matters
    // for any future shorter-token migration. 600/hr is well above any
    // legitimate dashboard polling cadence (30s = 120/hr at the busy end).
    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, `me_get:${ipH}`, 600);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    const user = await env.DB.prepare(`
        SELECT id, email, legal_name, yt_channel_id, yt_display_name_seen,
               verification_code, code_expires_at, state, email_prefs,
               show_on_leaderboard, badge_token, created_at, verified_at,
               current_streak, longest_streak, last_attendance_date
        FROM users WHERE dashboard_token = ?1 AND deleted_at IS NULL
    `).bind(token).first();

    if (!user) return json({ error: "not_found" }, 404);

    const attendance = await env.DB.prepare(`
        SELECT a.stream_id, a.earned_cpe, a.first_msg_at, a.rule_version, a.source,
               a.first_msg_sha256, a.created_at AS credited_at,
               s.scheduled_date, s.yt_video_id, s.title, s.actual_start_at
        FROM attendance a JOIN streams s ON s.id = a.stream_id
        WHERE a.user_id = ?1
        ORDER BY s.scheduled_date DESC, a.first_msg_at DESC
    `).bind(user.id).all();

    const certs = await env.DB.prepare(`
        SELECT id, public_token, period_yyyymm, cpe_total, sessions_count,
               state, cert_kind, stream_id, supersedes_cert_id,
               generated_at, delivered_at, first_viewed_at
        FROM certs WHERE user_id = ?1 AND state != 'regenerated'
        ORDER BY period_yyyymm DESC, created_at DESC
    `).bind(user.id).all();

    // Set of stream_ids the user already has a per_session cert for (any
    // non-terminal state). Drives the dashboard's per-row button: show
    // "Request cert for this session" only when none exists.
    const perSessionExisting = new Set(
        (certs.results || [])
            .filter(c => c.cert_kind === "per_session" && c.stream_id)
            .map(c => c.stream_id),
    );

    // Appeals in any state — the dashboard calendar marks the claimed_date
    // with a badge so the user sees their open/granted/denied claims
    // alongside credited days.
    const appeals = await env.DB.prepare(`
        SELECT id, claimed_date, state, created_at, resolved_at
          FROM appeals WHERE user_id = ?1
       ORDER BY created_at DESC
    `).bind(user.id).all();

    const totalCpe = (attendance.results || []).reduce((s, r) => s + r.earned_cpe, 0);

    // Out-of-window code post notifications — last 48h. The poller writes
    // an audit row with action='code_posted_outside_window' when it sees
    // a user's verification code in chat before the live window opens.
    // Surfacing these on the dashboard tells the user why they didn't get
    // credit without exposing the internal time-gate logic.
    // Out-of-window notifications (last 7d). Two flavors:
    //  - code_posted_outside_window: verification code posted pre-stream;
    //    user wasn't verified as a result.
    //  - attendance_outside_window: verified user's message was pre-stream
    //    and didn't earn attendance credit.
    // We surface both to the dashboard so the user has a clear answer when
    // they look at a stream they "thought" they attended and see no credit.
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const outsideWindow = await env.DB.prepare(`
        SELECT action, after_json, ts FROM audit_log
         WHERE action IN ('code_posted_outside_window','attendance_outside_window')
           AND entity_type = 'user' AND entity_id = ?1
           AND ts > ?2
         ORDER BY ts DESC LIMIT 10
    `).bind(user.id, cutoff).all();
    const codeWindowWarnings = (outsideWindow.results || []).map(r => {
        let d = {};
        try { d = JSON.parse(r.after_json || "{}"); } catch {}
        return {
            kind: r.action === "attendance_outside_window" ? "attendance" : "code",
            posted_at: d.posted_at, window_open_at: d.window_open_at, seen_at: r.ts,
        };
    });

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
           AND s.scheduled_date = date('now')
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

    let emailPrefs = { monthly_cert: true, cert_style: "bundled" };
    try {
        emailPrefs = { ...emailPrefs, ...(JSON.parse(user.email_prefs || "{}") || {}) };
    } catch { /* fall through to defaults */ }

    const attendanceWithFlags = (attendance.results || []).map(a => ({
        ...a,
        per_session_cert_exists: perSessionExisting.has(a.stream_id),
    }));

    return json({
        user: {
            legal_name: user.legal_name,
            email: user.email,
            yt_channel_id: user.yt_channel_id,
            yt_display_name_seen: user.yt_display_name_seen,
            state: user.state,
            code_state: codeState,
            code_expires_at: user.code_expires_at,
            email_prefs: emailPrefs,
            show_on_leaderboard: !!user.show_on_leaderboard,
            badge_token: user.badge_token,
            created_at: user.created_at,
            verified_at: user.verified_at,
        },
        attendance: attendanceWithFlags,
        certs: certs.results || [],
        appeals: appeals.results || [],
        total_cpe_earned: totalCpe,
        streaks: {
            current: user.current_streak || 0,
            longest: user.longest_streak || 0,
            last_date: user.last_attendance_date || null,
        },
        code_window_warnings: codeWindowWarnings,
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
