import { json, isSameOrigin, isValidToken, ulid, now, rateLimit, clientIp, ipHash, escapeHtml, emailShell, emailButton } from "../../../../_lib.js";

export async function onRequestPost({ params, request, env }) {
    const token = params.token;
    if (!isValidToken(token)) return json({ error: "invalid_token" }, 400);
    if (!isSameOrigin(request, env)) return json({ error: "forbidden_origin" }, 403);

    const certId = (params.cert_id || "").trim();
    if (!certId || certId.length > 40) return json({ error: "invalid_cert_id" }, 400);

    const user = await env.DB.prepare(
        "SELECT id FROM users WHERE dashboard_token = ?1 AND deleted_at IS NULL"
    ).bind(token).first();
    if (!user) return json({ error: "not_found" }, 404);

    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, `cert_resend:${user.id}`, 2);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    const cert = await env.DB.prepare(
        "SELECT id, public_token, user_id, state FROM certs WHERE id = ?1 AND user_id = ?2"
    ).bind(certId, user.id).first();
    if (!cert) return json({ error: "cert_not_found" }, 404);
    if (cert.state === "revoked" || cert.state === "pending") {
        return json({ error: "not_eligible" }, 400);
    }

    const lastEmail = await env.DB.prepare(
        "SELECT state FROM email_outbox WHERE idempotency_key = ?1 ORDER BY created_at DESC LIMIT 1"
    ).bind(certId).first();
    if (!lastEmail || (lastEmail.state !== "bounced" && lastEmail.state !== "failed")) {
        return json({ error: "not_eligible", detail: "email not in bounced/failed state" }, 400);
    }

    const userRow = await env.DB.prepare(
        "SELECT email, legal_name, dashboard_token FROM users WHERE id = ?1"
    ).bind(user.id).first();

    const siteBase = new URL(request.url).origin;
    const dashUrl = siteBase + "/dashboard.html?t=" + userRow.dashboard_token;
    const bodyHtml = `
<p>Hi ${escapeHtml(userRow.legal_name)},</p>
<p>Here is your certificate download link (re-sent at your request):</p>
${emailButton("Open Dashboard", dashUrl)}
<p style="font-size:13px;color:#555;">Your certificate is available on your dashboard.</p>`;
    const html = emailShell({
        title: "Certificate re-sent",
        preheader: "Your certificate download link",
        bodyHtml,
        siteBase,
    });

    const ts = now();
    await env.DB.prepare(
        `INSERT INTO email_outbox (id, user_id, template, to_email, subject, payload_json, idempotency_key, state, attempts, created_at)
         VALUES (?1, ?2, 'cert_resend', ?3, ?4, ?5, ?6, 'queued', 0, ?7)`
    ).bind(
        ulid(), user.id, userRow.email,
        "Your SC-CPE certificate (re-sent)",
        JSON.stringify({ html_body: html, text_body: "Visit your dashboard: " + dashUrl }),
        "resend:" + certId + ":" + ts,
        ts,
    ).run();

    return json({ ok: true, message: "Cert email re-queued" });
}
