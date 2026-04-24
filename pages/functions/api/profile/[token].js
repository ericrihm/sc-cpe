import { json, clientIp, ipHash, rateLimit } from "../../_lib.js";

export async function onRequestGet({ params, env, request }) {
    const token = params.token;
    if (!token || token.length < 16) return json({ error: "invalid_token" }, 400);

    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, `profile:${ipH}`, 120);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    const user = await env.DB.prepare(`
        SELECT id, legal_name, current_streak, longest_streak,
               last_attendance_date, created_at, verified_at
          FROM users
         WHERE badge_token = ?1 AND state = 'active' AND deleted_at IS NULL
    `).bind(token).first();

    if (!user) return json({ error: "not_found" }, 404);

    const totalCpe = await env.DB.prepare(
        "SELECT SUM(earned_cpe) AS total FROM attendance WHERE user_id = ?1"
    ).bind(user.id).first();

    const sessions = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM attendance WHERE user_id = ?1"
    ).bind(user.id).first();

    const certs = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM certs WHERE user_id = ?1 AND state NOT IN ('revoked','regenerated')"
    ).bind(user.id).first();

    const parts = (user.legal_name || "").trim().split(/\s+/);
    const first = parts[0] || "User";
    const lastInitial = parts.length > 1 ? parts[parts.length - 1][0] + "." : "";
    const displayName = lastInitial ? `${first} ${lastInitial}` : first;

    return json({
        display_name: displayName,
        member_since: user.verified_at || user.created_at,
        total_cpe: totalCpe?.total || 0,
        total_sessions: sessions?.n || 0,
        certs_earned: certs?.n || 0,
        current_streak: user.current_streak || 0,
        longest_streak: user.longest_streak || 0,
    });
}
