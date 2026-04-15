import { json, audit, clientIp, ipHash, isAdmin, queueEmail, now } from "../../../../_lib.js";

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

const SITE_BASE = "https://sc-cpe-web.pages.dev";

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

function buildBodies({ recipientName, periodDisplay, cpeTotal, sessionsCount, downloadUrl, verifyUrl, issuerName }) {
    const cpeStr = Number.isInteger(cpeTotal) ? `${cpeTotal}` : `${cpeTotal.toFixed(1)}`;
    const subject = `Your ${periodDisplay} Simply Cyber CPE certificate (re-issued link)`;
    const text =
        `Hi ${recipientName},\n\n` +
        `Your ${periodDisplay} Simply Cyber CPE certificate is ready.\n\n` +
        `  CPE credit hours: ${cpeStr}\n` +
        `  Sessions attended: ${sessionsCount}\n\n` +
        `Download your signed PDF (this link does not expire):\n  ${downloadUrl}\n\n` +
        `Anyone (including auditors) can verify this certificate at:\n  ${verifyUrl}\n\n` +
        `If you previously received a download link that returned an "X-Amz-Expires" ` +
        `error, the link above replaces it.\n\n— ${issuerName}\n`;
    const html = `<!doctype html>
<html><body style="font-family:Helvetica,Arial,sans-serif;color:#111;line-height:1.45;">
<p>Hi ${escapeHtml(recipientName)},</p>
<p>Your <strong>${escapeHtml(periodDisplay)}</strong> Simply Cyber CPE certificate is ready.</p>
<ul>
  <li>CPE credit hours: <strong>${escapeHtml(cpeStr)}</strong></li>
  <li>Sessions attended: <strong>${sessionsCount}</strong></li>
</ul>
<p>
  <a href="${downloadUrl}"
     style="display:inline-block;background:#0b3d5c;color:#fff;
            padding:10px 16px;border-radius:4px;text-decoration:none;">
     Download signed PDF
  </a><br/>
  <small style="color:#666;">This link does not expire — re-download anytime.</small>
</p>
<p>Anyone (including auditors) can verify this certificate:<br/>
<a href="${verifyUrl}">${verifyUrl}</a></p>
<p style="color:#666;font-size:12px;">If you previously received a link that returned an
<code>X-Amz-Expires</code> error, the link above replaces it.</p>
<p>— ${escapeHtml(issuerName)}</p>
</body></html>`;
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

    // period_yyyymm "202602" -> "February 2026"
    const yyyy = parseInt(cert.period_yyyymm.slice(0, 4), 10);
    const mm = parseInt(cert.period_yyyymm.slice(4, 6), 10);
    const periodDisplay = new Date(Date.UTC(yyyy, mm - 1, 1))
        .toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

    const downloadUrl = `${SITE_BASE}/api/download/${cert.public_token}`;
    const verifyUrl = `${SITE_BASE}/verify.html?t=${cert.public_token}`;

    const bodies = buildBodies({
        recipientName: cert.recipient_name_snapshot || cert.legal_name,
        periodDisplay,
        cpeTotal: cert.cpe_total,
        sessionsCount: cert.sessions_count,
        downloadUrl,
        verifyUrl,
        issuerName: cert.issuer_name_snapshot || "Simply Cyber LLC",
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
