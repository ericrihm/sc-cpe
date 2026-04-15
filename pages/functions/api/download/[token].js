import { audit, clientIp, ipHash } from "../../_lib.js";

// Durable cert-PDF download endpoint. Email links point here instead of at
// a presigned R2 URL because S3 presigned URLs cap at 604800s (7 days) —
// our monthly certs need to stay reachable indefinitely (auditors may check
// months or years later). Auth is "knowing the public_token," same bar as
// /api/verify/{token}; if we ever tighten that we'll add a dashboard_token
// alternative here.
//
// Flow: public_token -> look up cert -> 410 if revoked, 404 if missing,
// otherwise stream the object directly from the R2 binding (no presigning).
export async function onRequestGet({ params, env, request }) {
    const token = params.token;
    if (!token || token.length < 32 || token.length > 128) {
        return new Response("invalid token", { status: 400 });
    }

    const row = await env.DB.prepare(`
        SELECT id, pdf_r2_key, state, period_yyyymm, recipient_name_snapshot
        FROM certs WHERE public_token = ?1
    `).bind(token).first();

    if (!row) {
        return new Response("not found", { status: 404 });
    }
    if (row.state === "revoked") {
        return new Response("certificate revoked", { status: 410 });
    }
    if (!row.pdf_r2_key) {
        return new Response("pdf not available", { status: 404 });
    }

    const obj = await env.CERTS_BUCKET.get(row.pdf_r2_key);
    if (!obj) {
        return new Response("pdf missing from storage", { status: 404 });
    }

    await audit(env, "api", null, "cert_downloaded", "cert", row.id, null, {
        ip_hash: await ipHash(clientIp(request)),
    });

    // Safe filename: "<period>-<slug>.pdf". Strip anything not [A-Za-z0-9_-].
    const slugSource = (row.recipient_name_snapshot || "certificate")
        .replace(/[^A-Za-z0-9_-]+/g, "_")
        .slice(0, 60) || "certificate";
    const filename = `sc-cpe-${row.period_yyyymm}-${slugSource}.pdf`;

    return new Response(obj.body, {
        status: 200,
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${filename}"`,
            "Cache-Control": "private, max-age=0, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    });
}
