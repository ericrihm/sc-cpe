import { json } from "../../../_lib.js";
import { parseRange, groupByKey, guardAdmin } from "./_helpers.js";

export async function onRequestGet({ request, env }) {
    const denied = await guardAdmin(env, request);
    if (denied) return denied;

    const url = new URL(request.url);
    const { since, granularity } = parseRange(url);

    const grp = groupByKey(granularity).replace("{col}", "s.scheduled_date");
    const whereClause = since ? "WHERE s.scheduled_date >= ?1" : "";
    const binds = since ? [since] : [];

    const streamWhere = since ? "WHERE scheduled_date >= ?1" : "";

    const [avgPerStream, totalCpe, emptyStreams, timeSeries] = await Promise.all([
        since
            ? env.DB.prepare(
                `SELECT AVG(cnt) AS avg_att FROM (
                    SELECT COUNT(*) AS cnt FROM attendance a
                    JOIN streams s ON a.stream_id = s.id
                    WHERE s.scheduled_date >= ?1
                    GROUP BY a.stream_id
                )`
              ).bind(since).first()
            : env.DB.prepare(
                "SELECT AVG(cnt) AS avg_att FROM (SELECT COUNT(*) AS cnt FROM attendance GROUP BY stream_id)"
              ).first(),

        since
            ? env.DB.prepare(
                "SELECT SUM(a.earned_cpe) AS total FROM attendance a JOIN streams s ON a.stream_id = s.id WHERE s.scheduled_date >= ?1"
              ).bind(since).first()
            : env.DB.prepare("SELECT SUM(earned_cpe) AS total FROM attendance").first(),

        since
            ? env.DB.prepare(
                `SELECT COUNT(*) AS n FROM streams ${streamWhere}
                 AND id NOT IN (SELECT DISTINCT stream_id FROM attendance)`
              ).bind(since).first()
            : env.DB.prepare(
                "SELECT COUNT(*) AS n FROM streams WHERE id NOT IN (SELECT DISTINCT stream_id FROM attendance)"
              ).first(),

        since
            ? env.DB.prepare(
                `SELECT ${grp} AS period, COUNT(*) AS count
                 FROM attendance a JOIN streams s ON a.stream_id = s.id
                 ${whereClause} GROUP BY period ORDER BY period`
              ).bind(...binds).all()
            : env.DB.prepare(
                `SELECT ${grp} AS period, COUNT(*) AS count
                 FROM attendance a JOIN streams s ON a.stream_id = s.id
                 GROUP BY period ORDER BY period`
              ).all(),
    ]);

    return json({
        ok: true,
        headlines: {
            avg_attendance_per_stream: Math.round((avgPerStream?.avg_att ?? 0) * 10) / 10,
            total_cpe_awarded: totalCpe?.total ?? 0,
            streams_with_zero_attendance: emptyStreams?.n ?? 0,
        },
        series: (timeSeries?.results ?? []).map(r => ({ period: r.period, count: r.count })),
    });
}
