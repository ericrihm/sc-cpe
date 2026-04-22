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
        SELECT id, pdf_r2_key, pdf_sha256, state, period_yyyymm, recipient_name_snapshot
        FROM certs WHERE public_token = ?1
    `).bind(token).first();

    if (!row) {
        return new Response("not found", { status: 404 });
    }
    if (row.state === "revoked" || row.state === "regenerated") {
        return new Response("certificate revoked", { status: 410 });
    }
    if (!row.pdf_r2_key) {
        return new Response("pdf not available", { status: 404 });
    }
    // Defence-in-depth: period_yyyymm comes from the DB, but we splat it into
    // a Content-Disposition filename. Reject anything that isn't strict YYYYMM
    // so a poisoned row can't smuggle quotes/CRLF/path traversal.
    if (!/^\d{6}$/.test(row.period_yyyymm || "")) {
        return new Response("malformed period", { status: 500 });
    }

    const obj = await env.CERTS_BUCKET.get(row.pdf_r2_key);
    if (!obj) {
        return new Response("pdf missing from storage", { status: 404 });
    }

    // Recompute SHA-256 over the bytes we're about to ship and compare to the
    // hash the signer recorded. If R2 was tampered with (or the wrong object
    // ended up under this key), refuse to serve. Buffering the whole PDF is
    // fine — these are tens of KB.
    const bytes = await obj.arrayBuffer();
    if (row.pdf_sha256) {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hex = [...new Uint8Array(digest)]
            .map(b => b.toString(16).padStart(2, "0")).join("");
        if (hex !== row.pdf_sha256.toLowerCase()) {
            console.error("download:pdf_sha_mismatch", {
                cert_id: row.id, expected: row.pdf_sha256, actual: hex,
            });
            return new Response("certificate integrity check failed", { status: 410 });
        }
    }

    await audit(env, "api", null, "cert_downloaded", "cert", row.id, null, null, {
        ip_hash: await ipHash(clientIp(request)),
    });

    // Safe filename: "<period>-<slug>.pdf". Strip anything not [A-Za-z0-9_-].
    const slugSource = (row.recipient_name_snapshot || "certificate")
        .replace(/[^A-Za-z0-9_-]+/g, "_")
        .slice(0, 60) || "certificate";
    const filename = `sc-cpe-${row.period_yyyymm}-${slugSource}.pdf`;

    // attachment, not inline: the PDF is signed user-controlled-ish content
    // (recipient_name_snapshot makes it through the renderer). Letting
    // browsers preview it in-origin enables XSS-via-PDF-form-actions and
    // makes any future bug in the PDF rendering path same-origin scriptable.
    return new Response(bytes, {
        status: 200,
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "private, max-age=0, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    });
}
