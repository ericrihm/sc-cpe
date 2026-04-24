import { json, isAdmin, escapeLike, audit, clientIp, ipHash, sha256Hex } from "../../_lib.js";

// GET /api/admin/users?q=<query>[&limit=20]
// Auth: Authorization: Bearer <ADMIN_TOKEN>
//
// Free-text search over users. Matches against:
//   - email (case-insensitive prefix + contains)
//   - legal_name (case-insensitive contains)
//   - yt_channel_id (exact)
//   - id (exact ULID)
//
// Returns enough to let an admin pivot to a specific user's record without
// exposing dashboard_token, verification_code, or any live credential.
// Includes attendance and cert counts for quick triage.
export async function onRequestGet({ request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }

    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();
    if (!q || q.length < 2 || q.length > 200) {
        return json({ error: "query_required_2_to_200_chars" }, 400);
    }
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 100);

    // Escape `%` `_` `\` so a query of just `_` doesn't match every row and
    // turn the admin search into a "list everyone" oracle.
    const like = `%${escapeLike(q.toLowerCase())}%`;
    const sql = `
        SELECT u.id, u.email, u.legal_name, u.yt_channel_id,
               u.yt_display_name_seen, u.state, u.created_at, u.verified_at,
               u.deleted_at, u.suspended_at,
               (SELECT COUNT(*) FROM attendance a WHERE a.user_id = u.id) AS attendance_count,
               (SELECT COUNT(*) FROM certs    c WHERE c.user_id = u.id) AS cert_count,
               (SELECT COUNT(*) FROM appeals  ap WHERE ap.user_id = u.id AND ap.state = 'open') AS open_appeal_count
          FROM users u
         WHERE lower(u.email) LIKE ?1 ESCAPE '\\'
            OR lower(u.legal_name) LIKE ?1 ESCAPE '\\'
            OR u.yt_channel_id = ?2
            OR u.id = ?2
      ORDER BY u.created_at DESC
         LIMIT ?3
    `;
    const { results = [] } = await env.DB.prepare(sql).bind(like, q, limit).all();

    // Audit the search itself — admin lookups touch PII and must be
    // attributable. Entity is "users" collectively (no single id).
    // Don't store the raw query — admins search by email or name, which is
    // indefinite-retention PII in audit_log. Hash + length is enough for
    // attribution (an auditor can re-hash a suspected query to check).
    await audit(
        env, "admin", null, "admin_user_search", "users", "*",
        null, {
            query_sha256: await sha256Hex(q.toLowerCase()),
            query_length: q.length,
            count: results.length,
        },
        { ip_hash: await ipHash(clientIp(request)) },
    );

    return json({ ok: true, query: q, count: results.length, users: results });
}
