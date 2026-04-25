import { isAdmin } from "../../_lib.js";

export async function onRequestGet({ request, env }) {
    if (!(await isAdmin(env, request)))
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });

    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit"), 10) || 100, 1), 500);

    const clauses = [];
    const binds = [];

    if (q) {
        clauses.push("(LOWER(action) LIKE ?1 OR LOWER(entity_type) LIKE ?1 OR LOWER(entity_id) LIKE ?1 OR LOWER(actor_type) LIKE ?1 OR LOWER(COALESCE(actor_id,'')) LIKE ?1)");
        binds.push(`%${q}%`);
    }
    if (from) {
        clauses.push(`ts >= ?${binds.length + 1}`);
        binds.push(from + "T00:00:00Z");
    }
    if (to) {
        clauses.push(`ts <= ?${binds.length + 1}`);
        binds.push(to + "T23:59:59Z");
    }

    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const sql = `SELECT id, actor_type, actor_id, action, entity_type, entity_id, ts
                   FROM audit_log${where}
               ORDER BY ts DESC LIMIT ?${binds.length + 1}`;
    binds.push(limit);

    const { results } = await env.DB.prepare(sql).bind(...binds).all();

    return new Response(JSON.stringify({
        ok: true,
        count: results.length,
        rows: results,
    }), { headers: { "Content-Type": "application/json" } });
}
