import {
    randomToken, json, now, audit, clientIp, ipHash,
    queueEmail, escapeHtml, emailShell, isSameOrigin, rateLimit, sha256Hex,
    isValidToken,
} from "../../../_lib.js";

// POST /api/me/{dashboard_token}/rotate
//
// Invalidates the current dashboard token and emails a fresh URL to the
// address on file. The user (or attacker) holding the current URL can
// trigger this — same origin, with CSRF gate — but the NEW token is
// delivered only by email. Email-inbox possession is therefore the gate
// against a rotation-hijack by whoever leaked/stole the old URL.
//
// This is the first-line response to "my dashboard link leaked" and to
// "I think my laptop screen got screenshotted" without requiring us to
// build an account-recovery flow that needs another credential.

const MAX_PER_HOUR = 3;
function bodies({ legalName, dashboardUrl }) {
    const subject = "Simply Cyber CPE — your dashboard link has been rotated";
    const text =
        `Hi ${legalName},\n\n` +
        `Your SC-CPE dashboard link was just rotated. Bookmark the new\n` +
        `URL — your previous link no longer works:\n\n` +
        `  ${dashboardUrl}\n\n` +
        `If you did not request this rotation, your account is now safe:\n` +
        `the old link can no longer access the dashboard. Contact us if\n` +
        `anything else looks wrong.\n\n` +
        `— Simply Cyber\n`;
    const bodyHtml = `
<p>Hi ${escapeHtml(legalName)},</p>
<p>Your SC-CPE dashboard link was just rotated. <strong>Bookmark the new URL</strong> —
your previous link no longer works:</p>
<p>
  <a href="${dashboardUrl}"
     style="display:inline-block;background:#0b3d5c;color:#fff;
            padding:10px 16px;border-radius:4px;text-decoration:none;">
     Open my dashboard
  </a>
</p>
<p style="word-break:break-all;font-family:Menlo,monospace;font-size:12px;color:#555;">
  ${dashboardUrl}
</p>
<p style="color:#666;font-size:12px;">If you did not request this rotation,
your account is now safe: the old link can no longer access the dashboard.</p>`;
    return {
        subject, text,
        html: emailShell({
            title: "Dashboard link rotated",
            preheader: "Your new SC-CPE dashboard URL",
            bodyHtml,
        }),
    };
}

export async function onRequestPost({ params, request, env }) {
    const token = params.token;
    if (!isValidToken(token)) return json({ error: "invalid_token" }, 400);

    // CSRF gate — the dashboard token sits in the URL, so a browser will
    // happily POST here from any page that knows it. Same-origin only.
    if (!isSameOrigin(request, env)) {
        return json({ error: "forbidden_origin" }, 403);
    }

    const ip = clientIp(request);
    const ipH = await ipHash(ip);

    const user = await env.DB.prepare(
        "SELECT id, email, legal_name FROM users " +
        "WHERE dashboard_token = ?1 AND deleted_at IS NULL"
    ).bind(token).first();
    if (!user) return json({ error: "not_found" }, 404);

    // Per-user rate limit. Rotating >3/hour is almost certainly abuse.
    // Fail-closed via rateLimit() so a missing RATE_KV returns 503.
    const hourBucket = new Date().toISOString().slice(0, 13);
    const rl = await rateLimit(env, `rotate:${user.id}:${hourBucket}`, MAX_PER_HOUR);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    const newToken = randomToken();
    const newBadgeToken = randomToken();
    await env.DB.prepare(
        "UPDATE users SET dashboard_token = ?1, badge_token = ?2 WHERE id = ?3"
    ).bind(newToken, newBadgeToken, user.id).run();

    const siteBase = new URL(request.url).origin;
    const dashboardUrl = `${siteBase}/dashboard.html?t=${newToken}`;
    const b = bodies({
        legalName: user.legal_name || "there",
        dashboardUrl,
    });

    await queueEmail(env, {
        userId: user.id,
        template: "register",
        to: user.email,
        subject: b.subject,
        html: b.html,
        text: b.text,
        // Idempotency on (user, new_token) — same token never queues twice.
        idempotencyKey: `rotate:${user.id}:${await sha256Hex(newToken)}`,
    });

    await audit(env, "user", user.id, "dashboard_token_rotated", "user", user.id,
        null,
        {
            // Hash of the old token lets auditors link rotate events to
            // specific URL leaks without the token itself landing in the
            // append-only log.
            old_token_sha256: await sha256Hex(token),
            email_sha256: await sha256Hex(user.email),
        },
        { ip_hash: ipH });

    // Do NOT return the new token. Possession of the email inbox is the
    // gate — same philosophy as register.js.
    return json({ ok: true, email_sent: true });
}
