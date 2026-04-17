import { json, audit, clientIp, ipHash, rateLimit, now, ulid, isSameOrigin } from "../../../_lib.js";

// POST /api/me/{token}/appeal
// Body: { "claimed_date": "YYYY-MM-DD", "evidence_text"?: string }
//
// Creates an appeal for a missed attendance credit. The user claims they
// attended on a given date but didn't get credit. An admin resolves it
// via /api/admin/appeals/[id]/resolve.
//
// CSRF gate: dashboard_token in URL -> Origin check required.
export async function onRequestPost({ params, request, env }) {
    const token = params.token;
    if (!token || token.length < 32) return json({ error: "invalid_token" }, 400);
    if (!isSameOrigin(request, env)) return json({ error: "forbidden_origin" }, 403);

    const ip = await ipHash(clientIp(request));
    const rl = await rateLimit(env, `appeal:${ip}`, 10);
    if (!rl.ok) return json(rl.body, rl.status);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const claimedDate = typeof body?.claimed_date === "string" ? body.claimed_date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(claimedDate)) return json({ error: "invalid_date" }, 400);
    const d = new Date(claimedDate + "T12:00:00Z");
    if (isNaN(d.getTime())) return json({ error: "invalid_date" }, 400);
    if (d > new Date()) return json({ error: "future_date" }, 400);

    let evidenceText = null;
    if (body?.evidence_text != null) {
        if (typeof body.evidence_text !== "string") return json({ error: "invalid_evidence" }, 400);
        const trimmed = body.evidence_text.trim();
        if (trimmed.length > 500) return json({ error: "evidence_too_long" }, 400);
        evidenceText = trimmed.length ? trimmed : null;
    }

    const user = await env.DB.prepare(
        "SELECT id, yt_channel_id, yt_display_name_seen FROM users WHERE dashboard_token = ?1 AND deleted_at IS NULL"
    ).bind(token).first();
    if (!user) return json({ error: "not_found" }, 404);

    const existing = await env.DB.prepare(
        "SELECT id FROM appeals WHERE user_id = ?1 AND claimed_date = ?2 AND state = 'open'"
    ).bind(user.id, claimedDate).first();
    if (existing) return json({ error: "appeal_already_open", id: existing.id }, 409);

    const alreadyCredited = await env.DB.prepare(`
        SELECT 1 FROM attendance a JOIN streams s ON s.id = a.stream_id
        WHERE a.user_id = ?1 AND s.scheduled_date = ?2
    `).bind(user.id, claimedDate).first();
    if (alreadyCredited) return json({ error: "already_credited" }, 409);

    const stream = await env.DB.prepare(
        "SELECT id FROM streams WHERE scheduled_date = ?1 LIMIT 1"
    ).bind(claimedDate).first();

    const ts = now();
    const id = ulid();
    await env.DB.prepare(`
        INSERT INTO appeals (id, user_id, claimed_date, claimed_stream_id,
                             yt_display_name_used, evidence_text, state, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7)
    `).bind(id, user.id, claimedDate, stream ? stream.id : null,
            user.yt_display_name_seen, evidenceText, ts).run();

    await audit(
        env, "user", user.id, "appeal_created", "appeal", id,
        null, { claimed_date: claimedDate },
        { ip_hash: ip },
    );

    return json({ ok: true, id });
}
