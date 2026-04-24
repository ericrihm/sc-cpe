import { json, audit, clientIp, ipHash, isSameOrigin, rateLimit, ulid, now, isValidToken } from "../../../../_lib.js";

// POST /api/me/{token}/cert-per-session/{stream_id}
// Queues a per-session cert request. The monthly + pending-pickup cron
// generates, signs, and emails the PDF (typically within a few hours).
//
// Owner check: (users.dashboard_token, attendance.stream_id) must match in
// a single query so an attacker with a leaked token can't request a cert
// for a session the user didn't actually attend.
//
// Rate limit: 20/day/user. Typical month has ~22 DTBs, so this caps one
// user from nuking signing capacity without blocking normal use.
//
// Idempotency: if a non-revoked per_session cert already exists for this
// (user, stream) — in any state including 'pending' — we return that row's
// id rather than creating a duplicate. The UNIQUE index enforces this at
// the DB level; we surface the same shape to the client either way.
export async function onRequestPost({ params, request, env }) {
    const token = params.token;
    const streamId = params.stream_id;
    if (!isValidToken(token)) return json({ error: "invalid_token" }, 400);
    if (!streamId || streamId.length < 10) return json({ error: "invalid_stream_id" }, 400);
    if (!isSameOrigin(request, env)) return json({ error: "forbidden_origin" }, 403);

    const owner = await env.DB.prepare(`
        SELECT u.id AS user_id, u.email_prefs,
               s.id AS stream_pk, s.yt_video_id, s.scheduled_date, s.title,
               a.earned_cpe
          FROM users u
          JOIN attendance a ON a.user_id = u.id
          JOIN streams s ON s.id = a.stream_id
         WHERE u.dashboard_token = ?1 AND u.deleted_at IS NULL
           AND s.id = ?2
    `).bind(token, streamId).first();
    if (!owner) return json({ error: "not_found_or_not_attended" }, 404);

    const rl = await rateLimit(env, `cert_per_session:${owner.user_id}`, 20, 86400);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    const existing = await env.DB.prepare(`
        SELECT id, state, public_token FROM certs
         WHERE user_id = ?1 AND stream_id = ?2
           AND cert_kind = 'per_session' AND state != 'revoked'
    `).bind(owner.user_id, owner.stream_pk).first();
    if (existing) {
        return json({
            ok: true,
            queued: false,
            existing: true,
            cert_id: existing.id,
            state: existing.state,
            public_token: existing.public_token,
        });
    }

    const certId = ulid();
    const publicToken = randomHex(32);
    const date = owner.scheduled_date || new Date().toISOString().slice(0, 10);
    const periodYyyymm = date.slice(0, 4) + date.slice(5, 7);
    const ts = now();

    await env.DB.prepare(`
        INSERT INTO certs (
            id, public_token, user_id,
            period_yyyymm, period_start, period_end,
            cpe_total, sessions_count, session_video_ids,
            issuer_name_snapshot, recipient_name_snapshot,
            state, cert_kind, stream_id, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, 1, ?7, '', '',
                  'pending', 'per_session', ?8, ?9)
    `).bind(
        certId, publicToken, owner.user_id,
        periodYyyymm, date,
        owner.earned_cpe, JSON.stringify([owner.yt_video_id]),
        owner.stream_pk, ts,
    ).run();

    await audit(
        env, "user", owner.user_id, "cert_per_session_requested",
        "cert", certId,
        null,
        { stream_id: owner.stream_pk, yt_video_id: owner.yt_video_id,
          scheduled_date: date, cert_kind: "per_session" },
        { ip_hash: await ipHash(clientIp(request)) },
    );

    return json({
        ok: true, queued: true, cert_id: certId, state: "pending",
        note: "Your per-session certificate is queued. You'll receive an email once it's signed (typically within a few hours).",
    });
}

function randomHex(nBytes) {
    const rnd = crypto.getRandomValues(new Uint8Array(nBytes));
    return [...rnd].map(b => b.toString(16).padStart(2, "0")).join("");
}
