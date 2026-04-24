import { isAdmin } from "../../_lib.js";

export async function onRequestGet({ request, env }) {
    if (!(await isAdmin(env, request))) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401, headers: { "Content-Type": "application/json" },
        });
    }

    const url = new URL(request.url);
    const type = url.searchParams.get("type");
    if (!type || !["users", "attendance", "certs"].includes(type)) {
        return new Response(JSON.stringify({ error: "invalid_type", valid: ["users", "attendance", "certs"] }), {
            status: 400, headers: { "Content-Type": "application/json" },
        });
    }

    let csv;
    if (type === "users") csv = await exportUsers(env);
    else if (type === "attendance") csv = await exportAttendance(env);
    else csv = await exportCerts(env);

    const ts = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="sc-cpe-${type}-${ts}.csv"`,
            "Cache-Control": "no-store",
        },
    });
}

function csvRow(fields) {
    return fields.map(f => {
        const s = f == null ? "" : String(f);
        return s.includes(",") || s.includes('"') || s.includes("\n")
            ? '"' + s.replace(/"/g, '""') + '"'
            : s;
    }).join(",");
}

async function exportUsers(env) {
    const rows = (await env.DB.prepare(`
        SELECT id, email, legal_name, yt_channel_id, state,
               show_on_leaderboard, current_streak, longest_streak,
               last_attendance_date, created_at, verified_at
          FROM users WHERE deleted_at IS NULL
      ORDER BY created_at DESC
    `).all()).results || [];

    const header = csvRow(["id", "email", "legal_name", "yt_channel_id", "state",
        "show_on_leaderboard", "current_streak", "longest_streak",
        "last_attendance_date", "created_at", "verified_at"]);
    const lines = rows.map(r => csvRow([
        r.id, r.email, r.legal_name, r.yt_channel_id, r.state,
        r.show_on_leaderboard, r.current_streak, r.longest_streak,
        r.last_attendance_date, r.created_at, r.verified_at,
    ]));
    return header + "\n" + lines.join("\n") + "\n";
}

async function exportAttendance(env) {
    const rows = (await env.DB.prepare(`
        SELECT a.user_id, u.email, u.legal_name,
               a.stream_id, s.scheduled_date, s.yt_video_id, s.title,
               a.earned_cpe, a.source, a.first_msg_at, a.created_at
          FROM attendance a
          JOIN users u ON u.id = a.user_id
          JOIN streams s ON s.id = a.stream_id
         WHERE u.deleted_at IS NULL
      ORDER BY s.scheduled_date DESC, a.created_at DESC
    `).all()).results || [];

    const header = csvRow(["user_id", "email", "legal_name", "stream_id",
        "scheduled_date", "yt_video_id", "title", "earned_cpe", "source",
        "first_msg_at", "created_at"]);
    const lines = rows.map(r => csvRow([
        r.user_id, r.email, r.legal_name, r.stream_id, r.scheduled_date,
        r.yt_video_id, r.title, r.earned_cpe, r.source, r.first_msg_at, r.created_at,
    ]));
    return header + "\n" + lines.join("\n") + "\n";
}

async function exportCerts(env) {
    const rows = (await env.DB.prepare(`
        SELECT c.id, c.public_token, c.user_id, u.email, u.legal_name,
               c.period_yyyymm, c.cpe_total, c.sessions_count, c.cert_kind,
               c.state, c.generated_at, c.delivered_at, c.created_at
          FROM certs c
          JOIN users u ON u.id = c.user_id
         WHERE u.deleted_at IS NULL
      ORDER BY c.period_yyyymm DESC, c.created_at DESC
    `).all()).results || [];

    const header = csvRow(["cert_id", "public_token", "user_id", "email",
        "legal_name", "period", "cpe_total", "sessions_count", "cert_kind",
        "state", "generated_at", "delivered_at", "created_at"]);
    const lines = rows.map(r => csvRow([
        r.id, r.public_token, r.user_id, r.email, r.legal_name,
        r.period_yyyymm, r.cpe_total, r.sessions_count, r.cert_kind,
        r.state, r.generated_at, r.delivered_at, r.created_at,
    ]));
    return header + "\n" + lines.join("\n") + "\n";
}
