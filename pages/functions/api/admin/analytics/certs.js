import { json } from "../../../_lib.js";
import { parseRange, guardAdmin } from "./_helpers.js";

export async function onRequestGet({ request, env }) {
    const denied = await guardAdmin(env, request);
    if (denied) return denied;

    const url = new URL(request.url);
    const { since } = parseRange(url);

    const certStates = "('generated','delivered','viewed_by_auditor')";

    const [issuedPeriod, pending, deliveryLatency, viewRate, timeSeries] = await Promise.all([
        since
            ? env.DB.prepare(
                `SELECT COUNT(*) AS n FROM certs WHERE state IN ${certStates} AND created_at >= ?1`
              ).bind(since).first()
            : env.DB.prepare(
                `SELECT COUNT(*) AS n FROM certs WHERE state IN ${certStates}`
              ).first(),

        env.DB.prepare("SELECT COUNT(*) AS n FROM certs WHERE state = 'pending'").first(),

        since
            ? env.DB.prepare(
                `SELECT AVG(julianday(delivered_at) - julianday(created_at)) * 86400 AS avg_secs
                 FROM certs WHERE delivered_at IS NOT NULL AND created_at >= ?1`
              ).bind(since).first()
            : env.DB.prepare(
                "SELECT AVG(julianday(delivered_at) - julianday(created_at)) * 86400 AS avg_secs FROM certs WHERE delivered_at IS NOT NULL"
              ).first(),

        env.DB.prepare(
            `SELECT COUNT(CASE WHEN first_viewed_at IS NOT NULL THEN 1 END) AS viewed,
                    COUNT(*) AS total
             FROM certs WHERE delivered_at IS NOT NULL`
        ).first(),

        env.DB.prepare(
            `SELECT period_yyyymm AS period, COUNT(*) AS count
             FROM certs WHERE state IN ${certStates}
             GROUP BY period_yyyymm ORDER BY period_yyyymm`
        ).all(),
    ]);

    var avgLatencySecs = deliveryLatency?.avg_secs ?? null;

    return json({
        ok: true,
        headlines: {
            issued_this_period: issuedPeriod?.n ?? 0,
            pending_now: pending?.n ?? 0,
            avg_delivery_seconds: avgLatencySecs != null ? Math.round(avgLatencySecs) : null,
            view_rate_pct: (viewRate?.total ?? 0) > 0
                ? Math.round((viewRate.viewed / viewRate.total) * 100)
                : null,
        },
        series: (timeSeries?.results ?? []).map(r => ({ period: r.period, count: r.count })),
    });
}
