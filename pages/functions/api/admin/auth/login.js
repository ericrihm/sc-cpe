import {
    json, now, ulid, isValidEmail, verifyTurnstile, clientIp, ipHash,
    rateLimit, escapeHtml, emailShell, queueEmail,
} from "../../../_lib.js";
import { buildMagicLinkToken, MAGIC_LINK_MAX_AGE } from "./_auth_helpers.js";

const MAX_PER_HOUR = 5;
const CONSTANT_RESPONSE = {
    ok: true,
    message: "If that email is an admin account, we've sent a login link.",
};

function loginEmailBodies({ callbackUrl }) {
    const subject = "SC-CPE Admin Login";
    const text =
        "Click to sign in to the SC-CPE admin panel.\n\n" +
        "  " + callbackUrl + "\n\n" +
        "This link expires in 15 minutes. If you did not request this, ignore this email.\n\n" +
        "— Simply Cyber\n";
    const bodyHtml =
        "<p>Click to sign in to the SC-CPE admin panel.</p>" +
        '<p><a href="' + callbackUrl + '"' +
        ' style="display:inline-block;background:#0b3d5c;color:#fff;' +
        'padding:10px 16px;border-radius:4px;text-decoration:none;">' +
        "Sign in to Admin</a></p>" +
        '<p style="word-break:break-all;font-family:Menlo,monospace;font-size:12px;color:#555;">' +
        callbackUrl + "</p>" +
        '<p style="color:#666;font-size:12px;">This link expires in 15 minutes. If you did not ' +
        "request this, ignore this email.</p>";
    return {
        subject,
        text,
        html: emailShell({
            title: "Admin Login",
            preheader: "Your admin login link (expires in 15 min)",
            bodyHtml,
        }),
    };
}

export async function onRequestPost({ request, env }) {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const email = (body.email || "").trim().toLowerCase();
    const turnstileToken = body.turnstile_token;

    if (!isValidEmail(email)) return json({ error: "invalid_email" }, 400);

    const captcha = await verifyTurnstile(env, turnstileToken, clientIp(request));
    if (!captcha.ok) return json({ error: "captcha_failed" }, 403);

    const ip = clientIp(request);
    const ipH = await ipHash(ip);
    const hourBucket = new Date().toISOString().slice(0, 13);
    const rateKey = "admin_login:" + ipH + ":" + hourBucket;
    const rl = await rateLimit(env, rateKey, MAX_PER_HOUR);
    if (!rl.ok) {
        if (rl.status === 429) return json(CONSTANT_RESPONSE, 200);
        return json(rl.body, rl.status);
    }

    const admin = await env.DB.prepare(
        "SELECT id, email FROM admin_users WHERE lower(email) = ?1"
    ).bind(email).first();

    if (!admin) return json(CONSTANT_RESPONSE, 200);

    if (!env.ADMIN_COOKIE_SECRET) {
        console.error("ADMIN_COOKIE_SECRET not set — cannot send magic link");
        return json(CONSTANT_RESPONSE, 200);
    }

    const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
        .map(b => b.toString(16).padStart(2, "0")).join("");
    const expires = Date.now() + MAGIC_LINK_MAX_AGE;

    await env.RATE_KV.put("admin_nonce:" + nonce, email, { expirationTtl: 900 });

    const token = await buildMagicLinkToken(email, expires, nonce, env.ADMIN_COOKIE_SECRET);
    const redirect = body.redirect || "/admin.html";
    const siteBase = new URL(request.url).origin;
    const callbackUrl = siteBase + "/api/admin/auth/callback?token=" +
        encodeURIComponent(token) + "&redirect=" + encodeURIComponent(redirect);

    const bodies = loginEmailBodies({ callbackUrl });
    await queueEmail(env, {
        userId: null,
        template: "admin_login",
        to: admin.email,
        subject: bodies.subject,
        html: bodies.html,
        text: bodies.text,
        idempotencyKey: "admin_login:" + admin.id + ":" + hourBucket,
    });

    return json(CONSTANT_RESPONSE, 200);
}
