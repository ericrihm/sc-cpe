import { json, ulid, isAdmin } from "../../../../_lib.js";
import { generateChallenge, buildRegistrationOptions } from "../_webauthn.js";

export async function onRequestPost({ request, env }) {
    const admin = await isAdmin(env, request);
    if (!admin) return json({ error: "unauthorized" }, 401);

    const url = new URL(request.url);
    const rpId = url.hostname;
    const challenge = generateChallenge();

    const existing = await env.DB.prepare(
        "SELECT credential_id, transports FROM admin_passkeys WHERE admin_id = ?1"
    ).bind(admin.id).all();

    const options = buildRegistrationOptions({
        rpId,
        rpName: "SC-CPE Admin",
        userName: admin.email,
        userId: String(admin.id),
        challenge,
        excludeCredentials: existing.results || [],
    });

    await env.RATE_KV.put(
        "webauthn_challenge:" + challenge,
        JSON.stringify({ challenge, adminId: admin.id, type: "register" }),
        { expirationTtl: 300 },
    );

    return json(options);
}
