import { json, audit, clientIp, ipHash } from "../../_lib.js";

// Map free-text admin reason to a public enum. Anything we don't recognise
// becomes "other" so a careless admin note never reaches the verifier.
function classifyRevocation(reason) {
    const r = String(reason || "").toLowerCase();
    if (/fraud|fake|forg|impersonat/.test(r)) return "issued_in_error";
    if (/duplicate|superseded|replaced|reissued/.test(r)) return "superseded";
    if (/withdraw|delete|gdpr|right to be forgotten/.test(r)) return "subject_request";
    if (/key|signing|cert/.test(r)) return "key_compromise";
    return "other";
}

export async function onRequestGet({ params, env, request }) {
    const token = params.token;
    if (!token || token.length < 32 || token.length > 128) {
        return json({ valid: false, error: "invalid_token" }, 400);
    }

    const row = await env.DB.prepare(`
        SELECT c.id, c.public_token, c.period_yyyymm, c.period_start, c.period_end,
               c.cpe_total, c.sessions_count, c.issuer_name_snapshot,
               c.recipient_name_snapshot, c.signing_cert_sha256, c.pdf_sha256,
               c.state, c.revocation_reason, c.revoked_at, c.generated_at
        FROM certs c WHERE c.public_token = ?1
    `).bind(token).first();

    if (!row) {
        return new Response(JSON.stringify({ valid: false }), {
            status: 404,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
            },
        });
    }

    await env.DB.prepare(`
        UPDATE certs SET first_viewed_at = COALESCE(first_viewed_at, ?1)
        WHERE id = ?2 AND first_viewed_at IS NULL
    `).bind(new Date().toISOString(), row.id).run();

    await audit(env, "api", null, "cert_verified", "cert", row.id, null, {
        ip_hash: await ipHash(clientIp(request)),
    });

    const payload = {
        valid: row.state !== "revoked",
        state: row.state,
        issuer: row.issuer_name_snapshot,
        recipient: row.recipient_name_snapshot,
        period_yyyymm: row.period_yyyymm,
        period_start: row.period_start,
        period_end: row.period_end,
        cpe_total: row.cpe_total,
        sessions_count: row.sessions_count,
        signing_cert_sha256: row.signing_cert_sha256,
        pdf_sha256: row.pdf_sha256,
        issued_at: row.generated_at,
    };
    if (row.state === "revoked") {
        payload.revoked_at = row.revoked_at;
        // Don't expose the free-text admin reason publicly — it can name the
        // recipient, leak ongoing investigations, or shame people. Map to an
        // opaque enum the relying party can decide what to do with.
        payload.revocation_reason = classifyRevocation(row.revocation_reason);
    }

    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
    });
}
