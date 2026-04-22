import {
    ulid, randomCode, formatCode, json, now, audit, clientIp, ipHash,
    queueEmail, escapeHtml, emailShell, isSameOrigin, rateLimit,
} from "../../../_lib.js";

// POST /api/me/{dashboard_token}/resend-code
//
// User self-service for "I lost my verification code" or "my code expired".
// Generates a fresh 6-char code, extends expiry by 72 hours, and queues an
// email to the address on file. The endpoint is reachable only via the
// dashboard URL (the user's token), and rate-limited to 3/hour per dashboard
// token to keep someone with a leaked URL from spraying email.
//
// Refuses if the user is already 'active' (verified) — there's nothing to
// re-send. Refuses on deleted users.

const MAX_PER_HOUR = 3;
const SITE_BASE = "https://sc-cpe-web.pages.dev";

function bodies({ legalName, code, expiresAt, dashboardUrl }) {
    const display = formatCode(code);
    const subject = `Simply Cyber CPE — your new verification code`;
    const text =
        `Hi ${legalName},\n\n` +
        `You requested a fresh verification code. Paste this into a live chat\n` +
        `message during the Daily Threat Briefing on YouTube within 72 hours:\n\n` +
        `    ${display}\n\n` +
        `The code expires ${expiresAt}.\n\n` +
        `Your dashboard:\n  ${dashboardUrl}\n\n` +
        `If you did not request a new code, you can ignore this email.\n\n` +
        `— Simply Cyber\n`;
    const bodyHtml = `
<p>Hi ${escapeHtml(legalName)},</p>
<p>You requested a fresh verification code. Paste this into a live chat
message during the Daily Threat Briefing on YouTube within 72 hours:</p>
<p style="font-family:Menlo,monospace;font-size:20pt;text-align:center;
   background:#f4f6f8;padding:14px;border-radius:6px;letter-spacing:0.04em;">
   ${escapeHtml(display)}
</p>
<p>The code expires <strong>${escapeHtml(expiresAt)}</strong>.</p>
<p>Your dashboard:<br/>
<a href="${dashboardUrl}">${dashboardUrl}</a></p>
<p style="color:#666;font-size:12px;">If you did not request a new code,
you can ignore this email — your account is unchanged.</p>`;
    return {
        subject,
        text,
        html: emailShell({
            title: "New verification code",
            preheader: `Your new code: ${display}`,
            bodyHtml,
        }),
    };
}

export async function onRequestPost({ params, request, env }) {
    const token = params.token;
    if (!token || token.length < 32) return json({ error: "invalid_token" }, 400);

    // CSRF gate — see delete.js for rationale.
    if (!isSameOrigin(request, env)) {
        return json({ error: "forbidden_origin" }, 403);
    }

    const ip = clientIp(request);
    const ipH = await ipHash(ip);

    const user = await env.DB.prepare(`
        SELECT id, email, legal_name, state, dashboard_token, yt_channel_id
          FROM users WHERE dashboard_token = ?1 AND deleted_at IS NULL
    `).bind(token).first();
    if (!user) return json({ error: "not_found" }, 404);
    if (user.state === "active" && user.yt_channel_id) {
        return json({ error: "already_verified" }, 409);
    }

    // Per-token rate limit (token is the credential, user may roam IPs).
    // Fail-closed via rateLimit() helper — without RATE_KV bound this returns
    // 503 instead of silently disabling the cap.
    const hourBucket = new Date().toISOString().slice(0, 13);
    const rl = await rateLimit(env, `resend_code:${user.id}:${hourBucket}`, MAX_PER_HOUR);
    if (!rl.ok) return json(rl.body, rl.status);

    const code = await uniqueCode(env);
    // 72h — see register.js for rationale (race-attack window vs. weekend).
    const expiresAt = new Date(Date.now() + 3 * 864e5).toISOString();

    await env.DB.prepare(`
        UPDATE users SET verification_code = ?1, code_expires_at = ?2 WHERE id = ?3
    `).bind(code, expiresAt, user.id).run();

    const dashboardUrl = `${SITE_BASE}/dashboard.html?t=${user.dashboard_token}`;
    const b = bodies({
        legalName: user.legal_name || "there",
        code, expiresAt, dashboardUrl,
    });

    await queueEmail(env, {
        userId: user.id,
        template: "register",
        to: user.email,
        subject: b.subject,
        html: b.html,
        text: b.text,
        idempotencyKey: `resend_code:${user.id}:${code}`,
    });

    await audit(env, "user", user.id, "verification_code_resent", "user", user.id,
        null, { code_expires_at: expiresAt },
        { ip_hash: ipH });

    return json({ ok: true, code_expires_at: expiresAt });
}

async function uniqueCode(env) {
    for (let i = 0; i < 6; i++) {
        const c = randomCode();
        const clash = await env.DB.prepare(
            "SELECT 1 FROM users WHERE verification_code = ?1"
        ).bind(c).first();
        if (!clash) return c;
    }
    throw new Error("code_generation_retries_exhausted");
}
