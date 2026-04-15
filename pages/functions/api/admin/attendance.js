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
        "SELECT id, actual_start_at FROM streams WHERE id = ?1"
    ).bind(streamId).first();
    if (!stream) return json({ error: "stream_not_found" }, 404);

    // Optional chat evidence. When provided, we validate the message was
    // actually posted inside the live window before anchoring it as the
    // attendance row's first_msg_*. This keeps manual grants as defensible
    // as poller-credited ones: an auditor sees a real yt_message_id + sha256
    // of the chat text, not synthetic placeholders. Out-of-window evidence
    // is REJECTED — we will not launder an invalid post via admin override.
    const evidence = body?.chat_evidence;
    let evidenceBlock = null;
    if (evidence) {
        const ytId = (evidence.yt_message_id || "").trim();
        const publishedAt = (evidence.published_at || "").trim();
        const displayMessage = (evidence.display_message || "").toString();
        if (!ytId) return json({ error: "chat_evidence.yt_message_id required" }, 400);
        if (!publishedAt) return json({ error: "chat_evidence.published_at required" }, 400);
        if (!displayMessage) return json({ error: "chat_evidence.display_message required" }, 400);

        const pubMs = new Date(publishedAt).getTime();
        const startMs = new Date(stream.actual_start_at || 0).getTime();
        if (!Number.isFinite(pubMs) || !Number.isFinite(startMs)) {
            return json({ error: "invalid_timestamps" }, 400);
        }
        // Load current rule's pre_start_grace_min for the window check.
        const rs = await env.DB.prepare(
            "SELECT k, v FROM kv WHERE k LIKE 'rule_version.%'"
        ).all();
        const kv = Object.fromEntries((rs.results || []).map(r => [r.k, r.v]));
        const rv = parseInt(kv["rule_version.current"] || "1", 10);
        const grace = parseInt(kv[`rule_version.${rv}.pre_start_grace_min`] || "15", 10);
        const windowOpenMs = startMs + grace * 60_000;
        if (pubMs < windowOpenMs) {
            return json({
                error: "chat_evidence_outside_live_window",
                posted_at: publishedAt,
                window_opens_at: new Date(windowOpenMs).toISOString(),
                detail: "The supplied message was posted before the live window opened. Admin grants cannot launder an out-of-window post.",
            }, 409);
        }

        const sha = await sha256HexLocal(displayMessage);
        evidenceBlock = {
            first_msg_id: ytId,
            first_msg_at: publishedAt,
            first_msg_sha256: sha,
            first_msg_len: displayMessage.length,
        };
    }

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
    // Anchor first_msg_at to evidence when present, otherwise to the
    // stream's actual_start_at. "now" would be misleading.
    const firstMsgAt = evidenceBlock?.first_msg_at || stream.actual_start_at || ts;
    const firstMsgId = evidenceBlock?.first_msg_id || `admin:${resolver}:${ts}`;
    const firstSha = evidenceBlock?.first_msg_sha256 || "";
    const firstLen = evidenceBlock?.first_msg_len || 0;
    await env.DB.prepare(`
        INSERT INTO attendance
          (user_id, stream_id, earned_cpe, first_msg_id, first_msg_at,
           first_msg_sha256, first_msg_len, rule_version, source, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'admin_manual', ?9)
    `).bind(userId, streamId, cpe, firstMsgId, firstMsgAt, firstSha, firstLen,
            ruleVersion, ts).run();

    await audit(
        env, "admin", resolver, "attendance_granted_manual", "attendance",
        `${userId}:${streamId}`,
        null,
        {
            user_id: userId, stream_id: streamId, reason, rule_version: ruleVersion,
            earned_cpe: cpe,
            chat_evidence_present: !!evidenceBlock,
            ...(evidenceBlock ? {
                yt_message_id: evidenceBlock.first_msg_id,
                published_at: evidenceBlock.first_msg_at,
                msg_sha256: evidenceBlock.first_msg_sha256,
            } : {}),
        },
        { ip_hash: await ipHash(clientIp(request)) },
    );

    return json({
        ok: true,
        user_id: userId,
        stream_id: streamId,
        source: "admin_manual",
        earned_cpe: cpe,
        chat_evidence_present: !!evidenceBlock,
        created_at: ts,
    });
}

async function sha256HexLocal(s) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
