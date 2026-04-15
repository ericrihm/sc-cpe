import { json, audit, clientIp, ipHash, isAdmin, now, getCpePerDay } from "../../_lib.js";

// POST /api/admin/attendance
// Auth: Authorization: Bearer <ADMIN_TOKEN>
// Body: {
//   "user_id": "...",
//   "stream_id": "...",
//   "reason": "why this manual grant was made",
//   "resolver": "admin handle",
//   "rule_version": 1
// }
//
// Grants attendance credit with source='admin_manual'. Used for situations
// that don't fit the appeal flow (e.g., poller was down, operator correction).
// Appeal-driven grants should go through /api/admin/appeals/{id}/resolve,
// which carries the appeal state transition alongside the attendance insert.
//
// Refuses to overwrite an existing attendance row — if one exists, the caller
// presumably wants to reissue a cert rather than mutate attendance, which is
// a separate (and rarer) ceremony.
export async function onRequestPost({ request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const userId = (body?.user_id || "").trim();
    const streamId = (body?.stream_id || "").trim();
    const reason = (body?.reason || "").trim();
    const resolver = (body?.resolver || "").trim();
    const ruleVersion = parseInt(body?.rule_version, 10);

    if (!userId || userId.length < 10) return json({ error: "invalid_user_id" }, 400);
    if (!streamId || streamId.length < 10) return json({ error: "invalid_stream_id" }, 400);
    if (!reason || reason.length > 2000) return json({ error: "reason_required_under_2000_chars" }, 400);
    if (!resolver || resolver.length > 80) return json({ error: "resolver_required" }, 400);
    if (!Number.isFinite(ruleVersion) || ruleVersion < 1) return json({ error: "rule_version_required" }, 400);

    const user = await env.DB.prepare(
        "SELECT id, state, deleted_at FROM users WHERE id = ?1"
    ).bind(userId).first();
    if (!user) return json({ error: "user_not_found" }, 404);
    if (user.deleted_at) return json({ error: "user_deleted" }, 409);

    const stream = await env.DB.prepare(
        "SELECT id FROM streams WHERE id = ?1"
    ).bind(streamId).first();
    if (!stream) return json({ error: "stream_not_found" }, 404);

    const existing = await env.DB.prepare(
        "SELECT source, created_at FROM attendance WHERE user_id = ?1 AND stream_id = ?2"
    ).bind(userId, streamId).first();
    if (existing) {
        return json({
            error: "attendance_already_recorded",
            existing_source: existing.source,
            existing_created_at: existing.created_at,
        }, 409);
    }

    const ts = now();
    const cpe = await getCpePerDay(env, ruleVersion);
    await env.DB.prepare(`
        INSERT INTO attendance
          (user_id, stream_id, earned_cpe, first_msg_id, first_msg_at,
           first_msg_sha256, first_msg_len, rule_version, source, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, '', 0, ?6, 'admin_manual', ?7)
    `).bind(userId, streamId, cpe, `admin:${resolver}:${ts}`, ts, ruleVersion, ts).run();

    await audit(
        env, "admin", resolver, "attendance_granted_manual", "attendance",
        `${userId}:${streamId}`,
        null,
        { user_id: userId, stream_id: streamId, reason, rule_version: ruleVersion, earned_cpe: cpe },
        { ip_hash: await ipHash(clientIp(request)) },
    );

    return json({
        ok: true,
        user_id: userId,
        stream_id: streamId,
        source: "admin_manual",
        earned_cpe: cpe,
        created_at: ts,
    });
}
