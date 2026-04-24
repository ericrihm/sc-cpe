import {
    ulid, randomCode, formatCode, randomToken, json, now, audit, clientIp, ipHash,
    isValidEmail, isValidName, verifyTurnstile, queueEmail,
    escapeHtml, emailShell, emailButton, emailCode, emailDivider,
    sha256Hex, rateLimit, killSwitched, killedResponse,
} from "../_lib.js";

// Defence-in-depth against a Turnstile-solver farm. Turnstile is the first
// gate (~$0.002/solve on grey-market solvers), this is the second — 10
// successful Turnstiles per IP per hour is plenty for any legit user (code
// expires after 72h; you rarely re-register more than once a day).
const MAX_REGISTRATIONS_PER_HOUR = 10;

function welcomeEmailBodies({ legalName, code, dashboardToken, expiresAt, siteBase }) {
    const dashUrl = `${siteBase}/dashboard.html?t=${dashboardToken}`;
    const display = formatCode(code);
    const subject = `Your CPE verification code: ${display}`;
    const text = (
        `Hi ${legalName},\n\n` +
        `Welcome to Simply Cyber CPE! Here's your verification code:\n\n` +
        `    ${display}\n\n` +
        `Post this code in the YouTube chat during any Daily Threat Briefing.\n` +
        `Our poller sees it and links your YouTube channel to this account.\n\n` +
        `Your dashboard (bookmark this — it's your access URL):\n` +
        `  ${dashUrl}\n\n` +
        `Code expires ${expiresAt}.\n\n` +
        `If you did not register for SC-CPE, ignore this email —\n` +
        `the account stays inactive unless the code is used.\n\n` +
        `— Simply Cyber\n`
    );
    const bodyHtml = `
<p>Hi ${escapeHtml(legalName)},</p>
<p>Welcome to <strong>Simply Cyber CPE</strong>! Here's your verification code:</p>
${emailCode(display)}
<p style="text-align:center;">Post this code in the YouTube chat during any Daily Threat Briefing.</p>
${emailButton("Open Your Dashboard", dashUrl)}
${emailDivider()}
<p style="font-size:13px;color:#555;">Code expires <strong>${escapeHtml(expiresAt)}</strong>.
Our poller watches the chat and links your YouTube channel to this registration.
If you didn't register, ignore this email — the account stays inactive.</p>`;
    const html = emailShell({
        title: "Verification code",
        preheader: "Post this code in the YouTube chat to start earning CPE credits",
        bodyHtml,
        siteBase,
    });
    return { subject, html, text };
}

export async function onRequestPost({ request, env }) {
    if (await killSwitched(env, "register")) return killedResponse();

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const email = (body.email || "").trim().toLowerCase();
    const legalName = (body.legal_name || "").trim();
    const legalAttested = !!body.legal_name_attested;
    const tosAccepted = !!body.tos;
    const tosVersion = (body.tos_version || "v1").slice(0, 20);
    const turnstileToken = body.turnstile_token;

    if (!isValidEmail(email)) return json({ error: "invalid_email" }, 400);
    if (!isValidName(legalName)) return json({ error: "invalid_name" }, 400);
    if (!legalAttested) return json({ error: "legal_name_attestation_required" }, 400);
    if (!tosAccepted) return json({ error: "tos_required" }, 400);

    const captcha = await verifyTurnstile(env, turnstileToken, clientIp(request));
    if (!captcha.ok) return json({ error: "captcha_failed", detail: captcha.reason }, 403);

    const ipH = await ipHash(clientIp(request));
    const hourBucket = new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
    const rl = await rateLimit(env, `register:${ipH}:${hourBucket}`, MAX_REGISTRATIONS_PER_HOUR);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    const existing = await env.DB.prepare(
        "SELECT id, state, dashboard_token FROM users WHERE lower(email) = ?1 AND deleted_at IS NULL"
    ).bind(email).first();

    if (existing && existing.state === "active") {
        // Do NOT return the dashboard_token here. The dashboard URL is the
        // only credential — leaking it on a 409 lets anyone who knows a
        // registered email harvest the active token (Turnstile is the only
        // gate). Direct the caller through /dashboard.html instead, which is
        // rate-limited and emails the link to the address on file.
        return json({
            error: "already_registered",
            recover_url: "/dashboard.html",
        }, 409);
    }

    const nowIso = now();
    // 72h covers any weekday-registered user through the next briefing (and
    // weekend registrations through Monday's). Shorter than the original
    // 7d to limit the window for a chat-tailing race attack on the code.
    const expiresAt = new Date(Date.now() + 3 * 864e5).toISOString();
    let code;
    try { code = await uniqueCode(env); }
    catch { return json({ error: "temporary_error" }, 503); }

    if (existing) {
        await env.DB.prepare(`
            UPDATE users SET
                legal_name = ?1,
                verification_code = ?2,
                code_expires_at = ?3,
                legal_name_attested = 1,
                age_attested_13plus = 1,
                tos_version_accepted = ?4
            WHERE id = ?5
        `).bind(legalName, code, expiresAt, tosVersion, existing.id).run();

        await audit(env, "user", existing.id, "registration_reissued", "user", existing.id,
            null, { email_sha256: await sha256Hex(email) }, { ip_hash: await ipHash(clientIp(request)) });

        const siteBase = new URL(request.url).origin;
        const bodies = welcomeEmailBodies({
            legalName, code, dashboardToken: existing.dashboard_token, expiresAt, siteBase,
        });
        await queueEmail(env, {
            userId: existing.id,
            template: "register",
            to: email,
            subject: bodies.subject,
            html: bodies.html,
            text: bodies.text,
            idempotencyKey: `register:${existing.id}:${code}`,
        });

        // Do NOT return dashboard_url or verification_code. Possession of the
        // email inbox is the activation gate — otherwise a Turnstile-solving
        // attacker who knows a victim's email gets the dashboard token and
        // can bind a chat-posted code to the victim's account.
        return json({ ok: true, email_sent: true, expires_at: expiresAt });
    }

    const userId = ulid();
    const dashboardToken = randomToken();
    const badgeToken = randomToken();

    await env.DB.prepare(`
        INSERT INTO users (id, email, legal_name, verification_code, code_expires_at,
                           dashboard_token, badge_token, state, legal_name_attested,
                           age_attested_13plus, tos_version_accepted, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending_verification', 1, 1, ?8, ?9)
    `).bind(userId, email, legalName, code, expiresAt, dashboardToken, badgeToken, tosVersion, nowIso).run();

    await audit(env, "user", userId, "registration_created", "user", userId, null,
        { email_sha256: await sha256Hex(email) },
        { ip_hash: await ipHash(clientIp(request)) });

    const siteBase = new URL(request.url).origin;
    const bodies = welcomeEmailBodies({ legalName, code, dashboardToken, expiresAt, siteBase });
    await queueEmail(env, {
        userId,
        template: "register",
        to: email,
        subject: bodies.subject,
        html: bodies.html,
        text: bodies.text,
        idempotencyKey: `register:${userId}:${code}`,
    });

    return json({ ok: true, email_sent: true, expires_at: expiresAt });
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
