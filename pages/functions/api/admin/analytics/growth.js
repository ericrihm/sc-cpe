import { json } from "../../../_lib.js";
import { parseRange, groupByKey, guardAdmin } from "./_helpers.js";

export async function onRequestGet({ request, env }) {
    const denied = await guardAdmin(env, request);
    if (denied) return denied;

    const url = new URL(request.url);
    const { since, granularity } = parseRange(url);

    const grp = groupByKey(granularity).replace("{col}", "created_at");
    const whereClause = since ? "WHERE created_at >= ?1" : "";
    const binds = since ? [since] : [];

    const [totalUsers, activeUsers, verifiedUsers, activeAttenders, newReg, timeSeries] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE state = 'active'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE verified_at IS NOT NULL").first(),
        env.DB.prepare(
            "SELECT COUNT(DISTINCT user_id) AS n FROM attendance WHERE created_at >= ?1"
        ).bind(new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)).first(),
        since
            ? env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?1").bind(since).first()
            : env.DB.prepare("SELECT COUNT(*) AS n FROM users").first(),
        since
            ? env.DB.prepare(
                `SELECT ${grp} AS period, COUNT(*) AS count FROM users ${whereClause} GROUP BY period ORDER BY period`
              ).bind(...binds).all()
            : env.DB.prepare(
                `SELECT ${grp} AS period, COUNT(*) AS count FROM users GROUP BY period ORDER BY period`
              ).all(),
    ]);

    return json({
        ok: true,
        headlines: {
            total_users: totalUsers?.n ?? 0,
            active_users: activeUsers?.n ?? 0,
            verified_users: verifiedUsers?.n ?? 0,
            active_attenders_30d: activeAttenders?.n ?? 0,
            new_registrations: newReg?.n ?? 0,
        },
        series: (timeSeries?.results ?? []).map(r => ({ period: r.period, count: r.count })),
    });
}
