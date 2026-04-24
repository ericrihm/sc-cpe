import { derivePublicJwk } from "./sign.js";

export async function onRequestGet({ env }) {
    if (!env.OB_SIGNING_KEY) {
        return new Response(JSON.stringify({ error: "signing_not_configured" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
        });
    }

    const pub = await derivePublicJwk(env.OB_SIGNING_KEY);

    return new Response(JSON.stringify({
        keys: [{
            ...pub,
            kid: "ob-signing-key",
            use: "sig",
            alg: "EdDSA",
        }],
    }, null, 2), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
        },
    });
}
