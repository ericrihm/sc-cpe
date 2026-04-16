import {
    json, audit, clientIp, ipHash, isAdmin, now,
    classifyRevocation, sha256Hex,
} from "../../_lib.js";

// POST /api/admin/revoke
// Body: { "public_token": "...", "reason": "human-readable reason" }
// Auth: Authorization: Bearer <ADMIN_TOKEN>
//
// Flips certs.state='revoked' and records revocation_reason + revoked_at.
// Idempotent: revoking an already-revoked cert is a no-op (returns the
// existing revoked_at). Writes an audit row with the reason in after_json
// and the prior state in before_json so the chain tells the full story.
//
// /api/crl.json serves the public list of revoked tokens; verify endpoint
// already returns state='revoked' with the reason for end-users.
export async function onRequestPost({ request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return json({ error: "invalid_json" }, 400);
    }
    const token = (body?.public_token || "").trim();
    const reason = (body?.reason || "").trim();
    if (!token || token.length < 32 || token.length > 128) {
        return json({ error: "invalid_public_token" }, 400);
    }
    if (!reason || reason.length > 500) {
        return json({ error: "reason_required_under_500_chars" }, 400);
    }

    const row = await env.DB.prepare(`
        SELECT id, state, revoked_at, revocation_reason, user_id, period_yyyymm
        FROM certs WHERE public_token = ?1
    `).bind(token).first();

    if (!row) return json({ error: "cert_not_found" }, 404);

    if (row.state === "revoked") {
        return json({
            ok: true,
            already_revoked: true,
            revoked_at: row.revoked_at,
            revocation_reason: row.revocation_reason,
        });
    }

    const ts = now();
    await env.DB.prepare(`
        UPDATE certs
           SET state = 'revoked', revocation_reason = ?1, revoked_at = ?2
         WHERE id = ?3 AND state != 'revoked'
    `).bind(reason, ts, row.id).run();

    // Classify the free-text reason to an enum BEFORE writing audit. The
    // cleartext reason stays in certs.revocation_reason for internal admin
    // review, but audit_log is append-only and survives user deletion — it
    // must not hold free-form text that can name recipients or allegations.
    await audit(
        env,
        "admin",
        null,
        "cert_revoked",
        "cert",
        row.id,
        { state: row.state },
        {
            state: "revoked",
            revocation_class: classifyRevocation(reason),
            revocation_reason_sha256: await sha256Hex(reason),
            revocation_reason_length: reason.length,
            revoked_at: ts,
        },
        { ip_hash: await ipHash(clientIp(request)) },
    );

    return json({
        ok: true,
        cert_id: row.id,
        public_token: token,
        revoked_at: ts,
        revocation_reason: reason,
    });
}
