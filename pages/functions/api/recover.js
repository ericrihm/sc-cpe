import {
    ulid, json, now, audit, clientIp, ipHash,
    isValidEmail, verifyTurnstile, escapeHtml, emailShell, rateLimit,
    sha256Hex, killSwitched, killedResponse,
} from "../_lib.js";

const SITE_BASE = "https://sc-cpe-web.pages.dev";

function recoveryEmailBodies({ legalName, dashboardUrl }) {
    const subject = "Your Simply Cyber CPE dashboard link";
    const text = (
        `Hi ${legalName},\n\n` +
        `You (or someone using your email) requested your Simply Cyber CPE\n` +
        `dashboard link. Bookmark it — this URL is your account credential.\n\n` +
        `  ${dashboardUrl}\n\n` +
        `If you did not request this, you can ignore the email.\n\n` +
        `— Simply Cyber\n`
    );
    const bodyHtml = `
<p>Hi ${escapeHtml(legalName)},</p>
<p>You (or someone using your email) requested your Simply Cyber CPE dashboard link.
Bookmark it — this URL is your account credential.</p>
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
<p style="color:#666;font-size:12px;">If you did not request this, you can ignore
this email — no further action is taken.</p>`;
    return {
        subject,
        text,
        html: emailShell({
            title: "Dashboard recovery",
            preheader: "Your Simply Cyber CPE dashboard link",
            bodyHtml,
        }),
    };
}

// Dashboard-URL recovery. The dashboard token is the user's sole credential,
// so this endpoint must not leak which emails are registered — every valid
// input returns the same 200 body regardless of match. Per-IP rate limiting
// (5/hr) caps the blast radius if an attacker tries bulk enumeration anyway.
//
// Success path: if we find an active user, we queue a recovery email via
// email_outbox with idempotency_key=recover:{user_id}:{hour_bucket}, so two
// requests in the same hour for the same user collapse to one queued email.
// workers/email-sender drains the outbox every 2 min (templates: monthly_cert,
// recover, register), so delivery is typically within one drain cycle.

const MAX_PER_HOUR = 5;
const CONSTANT_RESPONSE = {
    ok: true,
    message: "If that email is registered, we've sent a recovery link.",
};

export async function onRequestPost({ request, env }) {
    if (await killSwitched(env, "recover")) return killedResponse();

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const email = (body.email || "").trim().toLowerCase();
    const turnstileToken = body.turnstile_token;

    // Input validation still returns specific errors — attackers can't use
    // these to enumerate (they're purely about syntax/captcha).
    if (!isValidEmail(email)) return json({ error: "invalid_email" }, 400);

    const captcha = await verifyTurnstile(env, turnstileToken, clientIp(request));
    if (!captcha.ok) return json({ error: "captcha_failed", detail: captcha.reason }, 403);

    const ip = clientIp(request);
    const ipH = await ipHash(ip);
    const hourBucket = new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
    const rateKey = `recover:${ipH}:${hourBucket}`;

    // Rate limit via the shared fail-closed helper. On over-limit we still
    // return the same constant-time 200 to preserve enumeration resistance —
    // the attacker shouldn't learn from a 429 that they hit a real lookup.
    // On a missing KV binding the helper returns 503; that's the right call
    // (refuse rather than silently drop the limiter).
    const rl = await rateLimit(env, rateKey, MAX_PER_HOUR);
    if (!rl.ok) {
        if (rl.status === 429) return json(CONSTANT_RESPONSE, 200);
        return json(rl.body, rl.status);
    }

    const user = await env.DB.prepare(
        "SELECT id, email, legal_name, dashboard_token FROM users " +
        "WHERE lower(email) = ?1 AND state = 'active' AND deleted_at IS NULL",
    ).bind(email).first();

    if (!user) {
        // No audit row — writing one on miss would create a side channel
        // visible to anyone with DB read access.
        return json(CONSTANT_RESPONSE, 200);
    }

    const emailId = ulid();
    const idempotencyKey = `recover:${user.id}:${hourBucket}`;
    const dashboardUrl = `${SITE_BASE}/dashboard.html?t=${user.dashboard_token}`;
    const bodies = recoveryEmailBodies({
        legalName: user.legal_name || "there",
        dashboardUrl,
    });
    // Pre-render html_body/text_body into payload_json so the email-sender
    // drainer can dispatch the row without re-rendering. Earlier this row
    // carried only metadata, which the drainer rejected as payload_missing_body
    // and burned through retries until it landed in 'failed' permanently.
    const payload = JSON.stringify({
        html_body: bodies.html,
        text_body: bodies.text,
    });

    try {
        await env.DB.prepare(`
            INSERT INTO email_outbox
              (id, user_id, template, to_email, subject,
               payload_json, idempotency_key, state, attempts, created_at)
            VALUES (?1, ?2, 'recover', ?3, ?4, ?5, ?6, 'queued', 0, ?7)
        `).bind(
            emailId, user.id, user.email,
            bodies.subject,
            payload,
            idempotencyKey,
            now(),
        ).run();
    } catch (err) {
        // UNIQUE on idempotency_key means we've already queued in this hour —
        // swallow and return the same response. Non-UNIQUE errors are real.
        if (!/UNIQUE/i.test(String(err && err.message || err))) throw err;
    }

    await audit(
        env, "user", user.id, "recovery_requested", "user", user.id,
        null, { email_sha256: await sha256Hex(email), idempotency_key: idempotencyKey },
        { ip_hash: ipH, user_agent: request.headers.get("User-Agent") || null },
    );

    return json(CONSTANT_RESPONSE, 200);
}

