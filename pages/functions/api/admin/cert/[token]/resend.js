import {
    json, audit, clientIp, ipHash, isAdmin, queueEmail, now,
    escapeHtml, emailShell, emailButton, emailDivider, rateLimit,
} from "../../../../_lib.js";

// POST /api/admin/cert/{public_token}/resend
// Auth: Authorization: Bearer <ADMIN_TOKEN>
//
// Re-queues the cert delivery email with the current durable download URL
// (sc-cpe-web.pages.dev/api/download/{token}). Use this for certs whose
// original email carried the legacy 30-day-presigned R2 URL — those URLs
// were rejected by S3 with "X-Amz-Expires must be less than a week" and
// have since expired, leaving recipients with broken links.
//
// Refuses to resend revoked certs (caller should not be advertising a
// revoked artefact) and skips certs without pdf_r2_key (no PDF to point at).
//
// Idempotency: each click takes a unique key so an admin can deliberately
// retry a stuck send. Use sparingly; the email_outbox drainer also
// auto-retries failed sends up to MAX_ATTEMPTS.

function buildBodies({ recipientName, periodDisplay, cpeTotal, sessionsCount, downloadUrl, verifyUrl, issuerName, siteBase }) {
    const cpeStr = Number.isInteger(cpeTotal) ? `${cpeTotal}` : `${cpeTotal.toFixed(1)}`;
    const subject = `Your ${periodDisplay} Simply Cyber CPE certificate (re-issued link)`;
    const text =
        `Hi ${recipientName},\n\n` +
        `Here's a fresh download link for your ${periodDisplay} CPE certificate.\n\n` +
        `  CPE credit hours: ${cpeStr}\n` +
        `  Sessions attended: ${sessionsCount}\n\n` +
        `Download: ${downloadUrl}\n\n` +
        `Verify: ${verifyUrl}\n\n` +
        `— ${issuerName}\n`;
    const bodyHtml = `
<p>Hi ${escapeHtml(recipientName)},</p>
<p>Here's a fresh download link for your <strong>${escapeHtml(periodDisplay)}</strong> CPE certificate.</p>
<div style="background:#f4f6f8;border-radius:8px;padding:16px 20px;margin:16px 0;">
  <table style="width:100%;border-collapse:collapse;">
    <tr><td style="padding:4px 0;color:#5b6473;">CPE Credits</td><td style="padding:4px 0;font-weight:700;text-align:right;">${escapeHtml(cpeStr)}</td></tr>
    <tr><td style="padding:4px 0;color:#5b6473;">Sessions</td><td style="padding:4px 0;font-weight:700;text-align:right;">${escapeHtml(String(sessionsCount))}</td></tr>
    <tr><td style="padding:4px 0;color:#5b6473;">Period</td><td style="padding:4px 0;font-weight:700;text-align:right;">${escapeHtml(periodDisplay)}</td></tr>
  </table>
</div>
${emailButton("Download Signed PDF", downloadUrl)}
${emailDivider()}
<p style="font-size:13px;color:#555;">Auditors and employers can verify at:<br/>
<a href="${verifyUrl}" style="color:#0b3d5c;">${verifyUrl}</a></p>`;
    const html = emailShell({
        title: `${periodDisplay} certificate`,
        preheader: `${cpeStr} CPE credits — download your signed PDF`,
        bodyHtml,
        siteBase,
    });
    return { subject, html, text };
}

export async function onRequestPost({ params, request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }

    const token = params.token;
    if (!token || token.length < 32 || token.length > 128) {
        return json({ error: "invalid_public_token" }, 400);
    }

    const cert = await env.DB.prepare(`
        SELECT c.id, c.public_token, c.user_id, c.period_yyyymm, c.cpe_total,
               c.sessions_count, c.state, c.pdf_r2_key, c.recipient_name_snapshot,
               c.issuer_name_snapshot,
               u.email, u.legal_name, u.deleted_at
          FROM certs c JOIN users u ON u.id = c.user_id
         WHERE c.public_token = ?1
    `).bind(token).first();

    if (!cert) return json({ error: "cert_not_found" }, 404);
    if (cert.state === "revoked") return json({ error: "cert_revoked" }, 409);
    if (!cert.pdf_r2_key) return json({ error: "cert_pdf_missing" }, 409);
    if (cert.deleted_at) return json({ error: "user_deleted" }, 409);

    const rl = await rateLimit(env, `cert_resend:${cert.id}`, 5);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    // period_yyyymm "202602" -> "February 2026"
    const yyyy = parseInt(cert.period_yyyymm.slice(0, 4), 10);
    const mm = parseInt(cert.period_yyyymm.slice(4, 6), 10);
    const periodDisplay = new Date(Date.UTC(yyyy, mm - 1, 1))
        .toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

    const siteBase = new URL(request.url).origin;
    const downloadUrl = `${siteBase}/api/download/${cert.public_token}`;
    const verifyUrl = `${siteBase}/verify.html?t=${cert.public_token}`;

    const bodies = buildBodies({
        recipientName: cert.recipient_name_snapshot || cert.legal_name,
        periodDisplay,
        cpeTotal: cert.cpe_total,
        sessionsCount: cert.sessions_count,
        downloadUrl,
        verifyUrl,
        issuerName: cert.issuer_name_snapshot || "Simply Cyber LLC",
        siteBase,
    });

    // Unique key per admin click so the drainer doesn't dedupe a deliberate
    // retry against an earlier resend or the original send.
    const idempotencyKey = `cert_resend:${cert.id}:${Date.now()}`;
    const queued = await queueEmail(env, {
        userId: cert.user_id,
        template: "cert_resend",
        to: cert.email,
        subject: bodies.subject,
        html: bodies.html,
        text: bodies.text,
        idempotencyKey,
    });

    await audit(
        env, "admin", null, "cert_email_resent", "cert", cert.id, null,
        {
            public_token: cert.public_token,
            to: cert.email,
            download_url: downloadUrl,
            idempotency_key: idempotencyKey,
            queued: queued.queued,
        },
        { ip_hash: await ipHash(clientIp(request)) },
    );

    return json({
        ok: true,
        cert_id: cert.id,
        public_token: cert.public_token,
        to: cert.email,
        download_url: downloadUrl,
        queued_at: now(),
        idempotency_key: idempotencyKey,
    });
}
