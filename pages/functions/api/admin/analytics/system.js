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

    const [emailStats, emailSeries, appealsOpen, appealResTime] = await Promise.all([
        since
            ? env.DB.prepare(
                `SELECT COUNT(CASE WHEN state = 'sent' THEN 1 END) AS sent,
                        COUNT(CASE WHEN state = 'failed' THEN 1 END) AS failed,
                        COUNT(*) AS total
                 FROM email_outbox WHERE created_at >= ?1`
              ).bind(since).first()
            : env.DB.prepare(
                `SELECT COUNT(CASE WHEN state = 'sent' THEN 1 END) AS sent,
                        COUNT(CASE WHEN state = 'failed' THEN 1 END) AS failed,
                        COUNT(*) AS total
                 FROM email_outbox`
              ).first(),

        since
            ? env.DB.prepare(
                `SELECT ${grp} AS period,
                        COUNT(CASE WHEN state = 'sent' THEN 1 END) AS sent,
                        COUNT(CASE WHEN state = 'failed' THEN 1 END) AS failed
                 FROM email_outbox ${whereClause}
                 GROUP BY period ORDER BY period`
              ).bind(...binds).all()
            : env.DB.prepare(
                `SELECT ${grp} AS period,
                        COUNT(CASE WHEN state = 'sent' THEN 1 END) AS sent,
                        COUNT(CASE WHEN state = 'failed' THEN 1 END) AS failed
                 FROM email_outbox
                 GROUP BY period ORDER BY period`
              ).all(),

        env.DB.prepare("SELECT COUNT(*) AS n FROM appeals WHERE state = 'open'").first(),

        since
            ? env.DB.prepare(
                `SELECT AVG(julianday(resolved_at) - julianday(created_at)) * 86400 AS avg_secs
                 FROM appeals WHERE resolved_at IS NOT NULL AND created_at >= ?1`
              ).bind(since).first()
            : env.DB.prepare(
                "SELECT AVG(julianday(resolved_at) - julianday(created_at)) * 86400 AS avg_secs FROM appeals WHERE resolved_at IS NOT NULL"
              ).first(),
    ]);

    var total = emailStats?.total ?? 0;
    var sent = emailStats?.sent ?? 0;

    return json({
        ok: true,
        headlines: {
            email_success_rate_pct: total > 0 ? Math.round((sent / total) * 100) : null,
            emails_sent: sent,
            appeals_open: appealsOpen?.n ?? 0,
            avg_appeal_resolution_seconds: appealResTime?.avg_secs != null
                ? Math.round(appealResTime.avg_secs)
                : null,
        },
        series: (emailSeries?.results ?? []).map(r => ({
            period: r.period,
            sent: r.sent,
            failed: r.failed,
        })),
    });
}
