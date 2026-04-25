import { json, ulid, audit, isAdmin, clientIp, ipHash } from "../../../../_lib.js";
import { verifyRegistration } from "../_webauthn.js";

export async function onRequestPost({ request, env }) {
    const admin = await isAdmin(env, request);
    if (!admin) return json({ error: "unauthorized" }, 401);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    if (!body.id || !body.response) return json({ error: "missing_credential" }, 400);

    const challengeKey = "webauthn_challenge:" + (body.response.clientDataJSON
        ? undefined : "");

    const url = new URL(request.url);
    const expectedOrigin = url.origin;
    const expectedRpId = url.hostname;

    const allChallenges = [];
    const clientDataJSON = body.response.clientDataJSON;
    if (!clientDataJSON) return json({ error: "missing_client_data" }, 400);

    const clientDataRaw = atob(clientDataJSON.replace(/-/g, "+").replace(/_/g, "/"));
    let clientData;
    try { clientData = JSON.parse(clientDataRaw); }
    catch { return json({ error: "invalid_client_data" }, 400); }

    const challenge = clientData.challenge;
    if (!challenge) return json({ error: "missing_challenge" }, 400);

    const stored = await env.RATE_KV.get("webauthn_challenge:" + challenge, "json");
    if (!stored || stored.adminId !== admin.id || stored.type !== "register") {
        return json({ error: "invalid_challenge" }, 400);
    }
    await env.RATE_KV.delete("webauthn_challenge:" + challenge);

    let result;
    try {
        result = await verifyRegistration({
            response: body.response,
            expectedChallenge: challenge,
            expectedOrigin,
            expectedRpId,
        });
    } catch (e) {
        return json({ error: "verification_failed", detail: e.message }, 400);
    }

    const id = ulid();
    await env.DB.prepare(
        `INSERT INTO admin_passkeys (id, admin_id, credential_id, public_key, counter, transports, backed_up)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(
        id, admin.id, result.credentialId, result.publicKey,
        result.counter, JSON.stringify(result.transports), result.backedUp ? 1 : 0,
    ).run();

    const ip = clientIp(request);
    const ipH = await ipHash(ip);
    await audit(
        env, "admin", admin.id, "passkey_registered", "admin_passkey", id,
        null, { credential_id_prefix: result.credentialId.slice(0, 16) },
        { ip_hash: ipH },
    );

    return json({ ok: true, passkey_id: id });
}
