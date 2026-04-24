import { json, isAdmin, sha256Hex, canonicalAuditRow } from "../../_lib.js";

// GET /api/admin/audit-chain-verify[?limit=1000]
// Auth: Authorization: Bearer <ADMIN_TOKEN>
//
// Walks the audit_log oldest-first, recomputes each row's prev_hash from the
// previous row's canonical serialisation, and reports the first divergence.
// Confirms two invariants the chain depends on:
//   1. No row's prev_hash disagrees with the canonical hash of its predecessor.
//   2. There is exactly one tip (no fork). The partial UNIQUE INDEX on
//      audit_log(prev_hash) WHERE prev_hash IS NOT NULL is what enforces
//      single-writer serialisation; without it concurrent writers can fork
//      the chain. We surface a missing index here so it can't go unnoticed.
//
// Heavy-ish endpoint (one digest per row), gated by admin auth and by an
// optional limit. Default 1000 = recent tail; capped at 50000.
export async function onRequestGet({ request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }

    const url = new URL(request.url);
    const rawLimit = parseInt(url.searchParams.get("limit") || "1000", 10);
    const limit = (rawLimit <= 0 || rawLimit > 50000) ? 50000 : rawLimit;

    // Index check — the partial UNIQUE INDEX is what serialises writers.
    const idxRow = await env.DB.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'audit_log' AND sql LIKE '%prev_hash%UNIQUE%'`
    ).first();
    // Fall back to a permissive check — different SQLite versions emit slightly
    // different sql casing.
    const anyIdx = await env.DB.prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'audit_log'`
    ).all();
    const hasUniqueOnPrev = (anyIdx?.results || []).some(r =>
        /unique/i.test(r.sql || "") && /prev_hash/i.test(r.sql || "")
    );

    const sql = `SELECT id, actor_type, actor_id, action, entity_type, entity_id,
                  before_json, after_json, ip_hash, user_agent, ts, prev_hash
             FROM audit_log
            ORDER BY ts ASC, id ASC
            LIMIT ?1`;
    const stmt = env.DB.prepare(sql).bind(limit);
    const { results = [] } = await stmt.all();

    let prev = null;
    let firstBreak = null;
    for (const row of results) {
        const expected = prev ? await sha256Hex(canonicalAuditRow(prev)) : null;
        if ((row.prev_hash || null) !== (expected || null)) {
            firstBreak = {
                id: row.id,
                ts: row.ts,
                expected_prev_hash: expected,
                actual_prev_hash: row.prev_hash,
            };
            break;
        }
        prev = row;
    }

    // Tip uniqueness: count rows whose hash is not anyone's prev_hash.
    const tipCount = await env.DB.prepare(`
        SELECT COUNT(*) AS n FROM audit_log a
         WHERE NOT EXISTS (
             SELECT 1 FROM audit_log b WHERE b.prev_hash IS NOT NULL
                AND b.prev_hash = (
                    SELECT prev_hash FROM audit_log WHERE id = a.id
                )
         )
    `).first();

    const ok = !firstBreak && hasUniqueOnPrev;
    return json({
        ok,
        rows_checked: results.length,
        first_break: firstBreak,
        unique_index_on_prev_hash: hasUniqueOnPrev,
        index_warning: hasUniqueOnPrev ? null
            : "missing partial UNIQUE INDEX on audit_log(prev_hash) WHERE prev_hash IS NOT NULL — chain forks possible under concurrent writers",
    }, ok ? 200 : 500);
}
