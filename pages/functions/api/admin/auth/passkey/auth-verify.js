import { json, audit, clientIp, ipHash, securityEvent } from "../../../../_lib.js";
import {
    buildSessionCookie, sessionCookieHeader, SESSION_MAX_AGE,
} from "../_auth_helpers.js";
import { verifyAuthentication, b64urlDecode } from "../_webauthn.js";

export async function onRequestPost({ request, env }) {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    if (!body.id || !body.response) return json({ error: "missing_credential" }, 400);

    const clientDataRaw = body.response.clientDataJSON;
    if (!clientDataRaw) return json({ error: "missing_client_data" }, 400);

    let clientData;
    try {
        const decoded = atob(clientDataRaw.replace(/-/g, "+").replace(/_/g, "/"));
        clientData = JSON.parse(decoded);
    } catch { return json({ error: "invalid_client_data" }, 400); }

    const challenge = clientData.challenge;
    if (!challenge) return json({ error: "missing_challenge" }, 400);

    const stored = await env.RATE_KV.get("webauthn_challenge:" + challenge, "json");
    if (!stored || stored.type !== "auth") {
        return json({ error: "invalid_challenge" }, 400);
    }
    await env.RATE_KV.delete("webauthn_challenge:" + challenge);

    const credentialId = body.id;
    const row = await env.DB.prepare(
        `SELECT p.id, p.admin_id, p.credential_id, p.public_key, p.counter,
                a.email, a.role
         FROM admin_passkeys p
         JOIN admin_users a ON a.id = p.admin_id
         WHERE p.credential_id = ?1`
    ).bind(credentialId).first();

    if (!row) {
        securityEvent(env, "auth_fail:passkey", "unknown credential").catch(() => {});
        return json({ error: "unknown_credential" }, 401);
    }

    const url = new URL(request.url);
    let result;
    try {
        result = await verifyAuthentication({
            response: body.response,
            expectedChallenge: challenge,
            expectedOrigin: url.origin,
            expectedRpId: url.hostname,
            credential: {
                publicKey: row.public_key,
                counter: row.counter,
                alg: -7,
            },
        });
    } catch (e) {
        securityEvent(env, "auth_fail:passkey", e.message).catch(() => {});
        return json({ error: "verification_failed", detail: e.message }, 401);
    }

    await env.DB.prepare(
        "UPDATE admin_passkeys SET counter = ?1, last_used_at = datetime('now') WHERE id = ?2"
    ).bind(result.signCount, row.id).run();

    if (!env.ADMIN_COOKIE_SECRET) return json({ error: "server_config" }, 500);

    const sessionExpires = Date.now() + SESSION_MAX_AGE;
    const cookieValue = await buildSessionCookie(row.email, sessionExpires, env.ADMIN_COOKIE_SECRET);

    const ip = clientIp(request);
    const ipH = await ipHash(ip);
    await audit(
        env, "admin", row.admin_id, "admin_login", "admin_user", row.admin_id,
        null, { method: "passkey", passkey_id: row.id },
        { ip_hash: ipH, user_agent: request.headers.get("User-Agent") || null },
    );

    return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Set-Cookie": sessionCookieHeader(cookieValue),
        },
    });
}
