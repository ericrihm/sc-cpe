import { json, audit, clientIp, ipHash, rateLimit } from "../../../_lib.js";
import { signCredential } from "../sign.js";

const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

function formatPeriod(yyyymm) {
    const y = yyyymm.slice(0, 4);
    const m = parseInt(yyyymm.slice(4), 10);
    return MONTHS[m - 1] + " " + y;
}

export function buildObCredential(cert, origin) {
    const period = formatPeriod(cert.period_yyyymm);
    return {
        "@context": [
            "https://www.w3.org/ns/credentials/v2",
            "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json",
        ],
        id: origin + "/api/ob/credential/" + cert.public_token + ".json",
        type: ["VerifiableCredential", "OpenBadgeCredential"],
        issuer: {
            id: origin,
            type: ["Profile"],
            name: "Simply Cyber",
            url: "https://www.youtube.com/@SimplyCyber",
        },
        validFrom: cert.generated_at,
        name: "Simply Cyber CPE Certificate — " + period,
        credentialSubject: {
            type: ["AchievementSubject"],
            achievement: {
                id: origin + "/achievements/cpe-attendance",
                type: ["Achievement"],
                name: "CPE/CEU Attendance Credit",
                description: "Continuing professional education credit earned by attending the Simply Cyber Daily Threat Briefing livestream.",
                criteria: {
                    narrative: "Attended " + cert.sessions_count + " Daily Threat Briefing sessions during " + period + ", verified via YouTube live chat code matching.",
                },
            },
        },
    };
}

export async function onRequestGet({ params, env, request }) {
    const raw = params.token;
    const token = raw?.endsWith(".json") ? raw.slice(0, -5) : raw;
    if (!token || token.length < 32 || token.length > 128) {
        return json({ error: "invalid_token" }, 400);
    }

    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, "ob_credential:" + ipH, 120);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    const row = await env.DB.prepare(`
        SELECT id, public_token, period_yyyymm, period_start, period_end,
               cpe_total, sessions_count, generated_at, recipient_name_snapshot,
               state
        FROM certs WHERE public_token = ?1
    `).bind(token).first();

    if (!row || row.state === "revoked" || row.state === "regenerated" || row.state === "pending") {
        return new Response(JSON.stringify({ error: "not_found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
    }

    if (!env.OB_SIGNING_KEY) {
        return json({ error: "signing_not_configured" }, 503);
    }

    const origin = new URL(request.url).origin;
    const credential = buildObCredential(row, origin);

    const proofValue = await signCredential(credential, env.OB_SIGNING_KEY);

    credential.proof = {
        type: "DataIntegrityProof",
        cryptosuite: "eddsa-rdfc-2022",
        verificationMethod: origin + "/api/ob/jwks#ob-signing-key",
        proofPurpose: "assertionMethod",
        created: row.generated_at,
        proofValue: proofValue,
    };

    await audit(env, "api", null, "credential_exported", "cert", row.id, null, null, {
        ip_hash: ipH,
    });

    return new Response(JSON.stringify(credential, null, 2), {
        status: 200,
        headers: {
            "Content-Type": "application/ld+json",
            "Cache-Control": "no-store",
        },
    });
}
