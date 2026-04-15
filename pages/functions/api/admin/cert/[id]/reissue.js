import { json, audit, clientIp, ipHash, isAdmin, ulid, now } from "../../../../_lib.js";

// POST /api/admin/cert/{id}/reissue
// Body: { "reason": "human-readable" }
//
// Queues a regeneration of cert {id}. Creates a NEW certs row with
// state='pending', cert_kind = the old cert's kind, stream_id = the old
// cert's stream_id (for per_session), supersedes_cert_id = {id}. The
// pending-pickup cron generates+signs+delivers; on delivery it flips the
// old cert's state to 'regenerated'.
//
// Idempotent: if a pending row already supersedes this cert, return it.
// Can't reissue a revoked cert (revocation is stronger than regeneration).
export async function onRequestPost({ params, request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }
    const certId = params.id;
    if (!certId || certId.length < 10) return json({ error: "invalid_cert_id" }, 400);

    let body = {};
    try { body = await request.json(); } catch { /* empty body is fine */ }
    const reason = (body?.reason || "").trim();
    if (!reason || reason.length > 500) {
        return json({ error: "reason_required_under_500_chars" }, 400);
    }

    const old = await env.DB.prepare(`
        SELECT id, user_id, period_yyyymm, period_start, period_end,
               cert_kind, stream_id, cpe_total, sessions_count,
               session_video_ids, state
          FROM certs WHERE id = ?1
    `).bind(certId).first();
    if (!old) return json({ error: "cert_not_found" }, 404);
    if (old.state === "revoked") {
        return json({ error: "cannot_reissue_revoked" }, 409);
    }

    const existing = await env.DB.prepare(
        "SELECT id, state FROM certs WHERE supersedes_cert_id = ?1 AND state = 'pending'"
    ).bind(certId).first();
    if (existing) {
        return json({ ok: true, reissued: false, pending_cert_id: existing.id });
    }

    const newId = ulid();
    const publicToken = randomHex(32);
    const ts = now();

    await env.DB.prepare(`
        INSERT INTO certs (
            id, public_token, user_id,
            period_yyyymm, period_start, period_end,
            cpe_total, sessions_count, session_video_ids,
            issuer_name_snapshot, recipient_name_snapshot,
            state, cert_kind, stream_id,
            supersedes_cert_id, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '', '',
                  'pending', ?10, ?11, ?12, ?13)
    `).bind(
        newId, publicToken, old.user_id,
        old.period_yyyymm, old.period_start, old.period_end,
        old.cpe_total, old.sessions_count, old.session_video_ids || "",
        old.cert_kind, old.stream_id,
        old.id, ts,
    ).run();

    await audit(
        env, "admin", null, "cert_reissue_requested",
        "cert", newId,
        { supersedes: old.id, state: old.state, reason },
        { new_cert_id: newId, cert_kind: old.cert_kind },
        { ip_hash: await ipHash(clientIp(request)) },
    );

    return json({
        ok: true, reissued: true, pending_cert_id: newId,
        supersedes_cert_id: old.id,
    });
}

function randomHex(nBytes) {
    const rnd = crypto.getRandomValues(new Uint8Array(nBytes));
    return [...rnd].map(b => b.toString(16).padStart(2, "0")).join("");
}
