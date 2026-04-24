import { json, clientIp, ipHash, rateLimit } from "../_lib.js";

export async function onRequestGet({ env, request }) {
    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, `leaderboard:${ipH}`, 120);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    const now = new Date();
    const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;

    const rows = await env.DB.prepare(`
        SELECT u.legal_name, u.current_streak,
               SUM(a.earned_cpe) AS cpe_earned,
               COUNT(a.stream_id) AS sessions
          FROM attendance a
          JOIN streams s ON s.id = a.stream_id
          JOIN users u ON u.id = a.user_id
         WHERE u.show_on_leaderboard = 1
           AND u.state = 'active'
           AND u.deleted_at IS NULL
           AND s.scheduled_date >= ?1
      GROUP BY u.id
      ORDER BY cpe_earned DESC, sessions DESC
         LIMIT 20
    `).bind(monthStart).all();

    const entries = (rows.results || []).map((r, i) => {
        const parts = (r.legal_name || "").trim().split(/\s+/);
        const first = parts[0] || "User";
        const lastInitial = parts.length > 1 ? parts[parts.length - 1][0] + "." : "";
        return {
            rank: i + 1,
            display_name: lastInitial ? `${first} ${lastInitial}` : first,
            cpe_earned: r.cpe_earned,
            sessions: r.sessions,
            streak: r.current_streak || 0,
        };
    });

    return json({
        period: yyyymm,
        entries,
    });
}
