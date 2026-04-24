import { json } from "../../../_lib.js";

// GET /api/me/{token}/annual-summary?year=2026
// Returns a JSON summary of a user's CPE for a given year, broken down by
// month. Provides the data a future PDF annual-summary generator would need.
export async function onRequestGet({ params, request, env }) {
    const token = params.token;
    if (!token || token.length < 32) return json({ error: "invalid_token" }, 400);

    const url = new URL(request.url);
    const yearParam = url.searchParams.get("year");
    const year = yearParam ? Number(yearParam) : new Date().getUTCFullYear();
    if (!Number.isInteger(year) || year < 2020 || year > 2100) {
        return json({ error: "invalid_year" }, 400);
    }

    const user = await env.DB.prepare(
        "SELECT id FROM users WHERE dashboard_token = ?1 AND deleted_at IS NULL"
    ).bind(token).first();
    if (!user) return json({ error: "not_found" }, 404);

    const startDate = `${year}-01-01`;
    const endDate = `${year + 1}-01-01`;

    const attendance = await env.DB.prepare(`
        SELECT a.earned_cpe, s.scheduled_date
        FROM attendance a
        JOIN streams s ON s.id = a.stream_id
        WHERE a.user_id = ?1
          AND s.scheduled_date >= ?2
          AND s.scheduled_date < ?3
        ORDER BY s.scheduled_date ASC
    `).bind(user.id, startDate, endDate).all();

    const certs = await env.DB.prepare(`
        SELECT id FROM certs
        WHERE user_id = ?1
          AND period_yyyymm >= ?2
          AND period_yyyymm <= ?3
          AND state NOT IN ('regenerated', 'revoked')
    `).bind(user.id, `${year}01`, `${year}12`).all();

    const months = [];
    for (let m = 1; m <= 12; m++) {
        const mm = String(m).padStart(2, "0");
        const prefix = `${year}-${mm}`;
        const monthRows = (attendance.results || []).filter(
            r => r.scheduled_date && r.scheduled_date.startsWith(prefix)
        );
        months.push({
            month: m,
            cpe: monthRows.reduce((sum, r) => sum + r.earned_cpe, 0),
            sessions: monthRows.length,
        });
    }

    const totalCpe = (attendance.results || []).reduce((sum, r) => sum + r.earned_cpe, 0);
    const totalSessions = (attendance.results || []).length;
    const certsIssued = (certs.results || []).length;

    return json({
        year,
        total_cpe: totalCpe,
        sessions_attended: totalSessions,
        certs_issued: certsIssued,
        months,
    });
}
