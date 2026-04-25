import { json, clientIp, ipHash, rateLimit } from "../../../../_lib.js";
import { generateChallenge, buildAuthenticationOptions } from "../_webauthn.js";

const MAX_PER_HOUR = 10;

export async function onRequestPost({ request, env }) {
    const ip = clientIp(request);
    const ipH = await ipHash(ip);
    const hourBucket = new Date().toISOString().slice(0, 13);
    const rl = await rateLimit(env, "passkey_auth:" + ipH + ":" + hourBucket, MAX_PER_HOUR);
    if (!rl.ok) {
        if (rl.status === 429) return json({ error: "rate_limited" }, 429);
        return json(rl.body, rl.status);
    }

    const url = new URL(request.url);
    const rpId = url.hostname;
    const challenge = generateChallenge();

    const options = buildAuthenticationOptions({ rpId, challenge });

    await env.RATE_KV.put(
        "webauthn_challenge:" + challenge,
        JSON.stringify({ challenge, type: "auth" }),
        { expirationTtl: 300 },
    );

    return json(options);
}
