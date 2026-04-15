import { json, isAdmin } from "../../_lib.js";

// GET /api/admin/cert-feedback?rating=typo,wrong&limit=100
// Returns recent cert_feedback rows joined with users + certs for the admin
// dashboard. Default filter: rating != 'ok' (the noisy bucket), newest first.
// Admin endpoints are bearer-gated; browsers don't auto-send Authorization
// cross-origin so no CSRF gate is needed.
export async function onRequestGet({ request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }
    const url = new URL(request.url);
    const ratingParam = (url.searchParams.get("rating") || "typo,wrong").trim();
    const ratings = ratingParam.split(",").map(s => s.trim())
        .filter(s => ["ok", "typo", "wrong"].includes(s));
    if (ratings.length === 0) return json({ error: "invalid_rating" }, 400);
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit"), 10) || 100));

    const placeholders = ratings.map((_, i) => `?${i + 1}`).join(",");
    const rows = await env.DB.prepare(`
        SELECT f.id, f.rating, f.note, f.created_at, f.updated_at,
               f.cert_id, c.period_yyyymm, c.cert_kind, c.state AS cert_state,
               c.public_token, c.stream_id,
               u.id AS user_id, u.email, u.legal_name
          FROM cert_feedback f
          JOIN certs c ON c.id = f.cert_id
          JOIN users u ON u.id = f.user_id
         WHERE f.rating IN (${placeholders})
      ORDER BY f.updated_at DESC
         LIMIT ?${ratings.length + 1}
    `).bind(...ratings, limit).all();

    const openReissues = await env.DB.prepare(`
        SELECT supersedes_cert_id FROM certs
         WHERE supersedes_cert_id IS NOT NULL AND state = 'pending'
    `).all();
    const pending = new Set((openReissues.results || []).map(r => r.supersedes_cert_id));

    const out = (rows.results || []).map(r => ({
        ...r,
        reissue_pending: pending.has(r.cert_id),
    }));
    return json({ ok: true, count: out.length, rows: out });
}
