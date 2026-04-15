// GET /api/crl.json — public Certificate Revocation List.
//
// Returns every revoked cert's public_token plus metadata. Auditors and
// integrators poll this to check cert validity without having to resolve
// each token individually against /api/verify. Cached at the edge for 5
// minutes — revocation is not latency-critical and this protects D1.
//
// Shape:
//   {
//     "generated_at": "2026-04-14T20:00:00Z",
//     "count": 3,
//     "revoked": [
//       { "public_token": "...", "revoked_at": "...", "reason": "...",
//         "period_yyyymm": "202603" }, ...
//     ]
//   }
function classifyRevocation(reason) {
    const r = String(reason || "").toLowerCase();
    if (/fraud|fake|forg|impersonat/.test(r)) return "issued_in_error";
    if (/duplicate|superseded|replaced|reissued/.test(r)) return "superseded";
    if (/withdraw|delete|gdpr|right to be forgotten/.test(r)) return "subject_request";
    if (/key|signing|cert/.test(r)) return "key_compromise";
    return "other";
}

export async function onRequestGet({ env }) {
    const rows = await env.DB.prepare(`
        SELECT public_token, revoked_at, revocation_reason, period_yyyymm
          FROM certs
         WHERE state = 'revoked'
         ORDER BY revoked_at ASC
    `).all();

    const body = JSON.stringify({
        generated_at: new Date().toISOString(),
        count: rows?.results?.length || 0,
        revoked: (rows?.results || []).map(r => ({
            public_token: r.public_token,
            revoked_at: r.revoked_at,
            // Public CRL — see verify/[token].js: never expose the free-text
            // admin reason. Map to an opaque enum.
            reason: classifyRevocation(r.revocation_reason),
            period_yyyymm: r.period_yyyymm,
        })),
    });

    return new Response(body, {
        status: 200,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=300",
            "Access-Control-Allow-Origin": "*",
        },
    });
}
