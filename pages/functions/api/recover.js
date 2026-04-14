import {
    ulid, json, now, audit, clientIp, ipHash,
    isValidEmail, verifyTurnstile,
} from "../_lib.js";

// Dashboard-URL recovery. The dashboard token is the user's sole credential,
// so this endpoint must not leak which emails are registered — every valid
// input returns the same 200 body regardless of match. Per-IP rate limiting
// (5/hr) caps the blast radius if an attacker tries bulk enumeration anyway.
//
// Success path: if we find an active user, we queue a recovery email via
// email_outbox with idempotency_key=recover:{user_id}:{hour_bucket}, so two
// requests in the same hour for the same user collapse to one queued email.
//
// The email_outbox consumer for non-monthly templates is not yet built — rows
// are queued but will only send once a consumer Worker is deployed. This is
// an accepted MVP gap; the row is durable and the consumer can drain later.

const MAX_PER_HOUR = 5;
const CONSTANT_RESPONSE = {
    ok: true,
    message: "If that email is registered, we've sent a recovery link.",
};

export async function onRequestPost({ request, env }) {
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

    // Rate limit. On over-limit we return the same constant-time 200 — the
    // attacker learns nothing from the response. We just skip DB work.
    const overLimit = await incrementAndCheck(env, rateKey, MAX_PER_HOUR);
    if (overLimit) {
        return json(CONSTANT_RESPONSE, 200);
    }

    const user = await env.DB.prepare(
        "SELECT id, email, dashboard_token FROM users " +
        "WHERE lower(email) = ?1 AND state = 'active' AND deleted_at IS NULL",
    ).bind(email).first();

    if (!user) {
        // No audit row — writing one on miss would create a side channel
        // visible to anyone with DB read access.
        return json(CONSTANT_RESPONSE, 200);
    }

    const emailId = ulid();
    const idempotencyKey = `recover:${user.id}:${hourBucket}`;
    const dashboardUrl = `/dashboard.html?t=${user.dashboard_token}`;
    const payload = {
        kind: "recover_dashboard",
        user_id: user.id,
        dashboard_url: dashboardUrl,
        requested_at: now(),
    };

    try {
        await env.DB.prepare(`
            INSERT INTO email_outbox
              (id, user_id, template, to_email, subject,
               payload_json, idempotency_key, state, attempts, created_at)
            VALUES (?1, ?2, 'recover_dashboard', ?3, ?4, ?5, ?6, 'queued', 0, ?7)
        `).bind(
            emailId, user.id, user.email,
            "Your Simply Cyber CPE dashboard link",
            JSON.stringify(payload),
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
        null, { email_lower: email, idempotency_key: idempotencyKey },
        { ip_hash: ipH, user_agent: request.headers.get("User-Agent") || null },
    );

    return json(CONSTANT_RESPONSE, 200);
}

// Atomic-ish increment of the hour counter. KV has no native increment, so we
// GET, compute, PUT. Under concurrent requests from the same IP we can race
// and slightly undercount — acceptable for this purpose (5/hr is a soft cap,
// not a security boundary; Turnstile is the primary anti-abuse layer).
async function incrementAndCheck(env, key, max) {
    if (!env.RATE_KV) {
        // KV binding missing (dev without config) — don't block, but warn.
        console.warn("RATE_KV unbound — rate limiting disabled");
        return false;
    }
    const current = parseInt(await env.RATE_KV.get(key), 10) || 0;
    if (current >= max) return true;
    await env.RATE_KV.put(key, String(current + 1), { expirationTtl: 3700 });
    return false;
}
