import { json, audit, clientIp, ipHash, now, ulid, isSameOrigin } from "../../../_lib.js";

// POST /api/me/{token}/cert-feedback
// Body: { "cert_id": "<ULID>", "rating": "ok"|"typo"|"wrong", "note"?: string }
//
// Feeds the product-improvement loop: recipients tell us when a cert has a
// typo / wrong total / wrong name. Stored deduped per (user, cert); a repeat
// submission overwrites. Non-ok ratings fire an audit_log row so the daily
// digest / admin dashboard can surface the backlog.
//
// CSRF gate: dashboard_token sits in URL → browsers auto-send it cross-origin
// on POST. Without the Origin check a third-party page could flood us with
// bogus feedback for any user whose token leaked via Referer.
export async function onRequestPost({ params, request, env }) {
    const token = params.token;
    if (!token || token.length < 32) {
        return json({ error: "invalid_token" }, 400);
    }
    if (!isSameOrigin(request, env)) {
        return json({ error: "forbidden_origin" }, 403);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const certId = typeof body?.cert_id === "string" ? body.cert_id : "";
    const rating = typeof body?.rating === "string" ? body.rating : "";
    const noteRaw = body?.note;
    if (!certId || certId.length > 40) {
        return json({ error: "invalid_cert_id" }, 400);
    }
    if (!["ok", "typo", "wrong"].includes(rating)) {
        return json({ error: "invalid_rating" }, 400);
    }
    // Note is optional; trim and cap. Anything longer is almost certainly
    // pasted garbage / abuse, not a real typo report.
    let note = null;
    if (noteRaw != null) {
        if (typeof noteRaw !== "string") return json({ error: "invalid_note" }, 400);
        const trimmed = noteRaw.trim();
        if (trimmed.length > 500) return json({ error: "note_too_long" }, 400);
        note = trimmed.length ? trimmed : null;
    }

    // Verify (token, cert) ownership in a single query so an attacker can't
    // leave feedback on someone else's cert by guessing cert_ids.
    const owner = await env.DB.prepare(`
        SELECT u.id AS user_id, c.id AS cert_id
          FROM users u
          JOIN certs c ON c.user_id = u.id
         WHERE u.dashboard_token = ?1 AND u.deleted_at IS NULL AND c.id = ?2
    `).bind(token, certId).first();
    if (!owner) return json({ error: "not_found" }, 404);

    const ts = now();
    const id = ulid();
    await env.DB.prepare(`
        INSERT INTO cert_feedback (id, user_id, cert_id, rating, note, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
        ON CONFLICT(user_id, cert_id) DO UPDATE SET
            rating = excluded.rating,
            note = excluded.note,
            updated_at = excluded.updated_at
    `).bind(id, owner.user_id, owner.cert_id, rating, note, ts).run();

    // Only audit non-ok ratings — "ok" is noise at volume. The action tag
    // `cert_feedback_issue` is what the weekly digest / admin UI keys on.
    if (rating !== "ok") {
        await audit(
            env, "user", owner.user_id, "cert_feedback_issue",
            "cert", owner.cert_id,
            null, { rating, note_len: note ? note.length : 0 },
            { ip_hash: await ipHash(clientIp(request)) },
        );
    }

    return json({ ok: true, rating, cert_id: owner.cert_id });
}
