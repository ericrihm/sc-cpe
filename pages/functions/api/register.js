import {
    ulid, randomCode, randomToken, json, now, audit, clientIp, ipHash,
    isValidEmail, isValidName, verifyTurnstile,
} from "../_lib.js";

export async function onRequestPost({ request, env }) {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const email = (body.email || "").trim().toLowerCase();
    const legalName = (body.legal_name || "").trim();
    const legalAttested = !!body.legal_name_attested;
    const ageAttested = !!body.age_attested_13plus;
    const tosVersion = body.tos_version || "v1";
    const turnstileToken = body.turnstile_token;

    if (!isValidEmail(email)) return json({ error: "invalid_email" }, 400);
    if (!isValidName(legalName)) return json({ error: "invalid_name" }, 400);
    if (!legalAttested) return json({ error: "legal_name_attestation_required" }, 400);
    if (!ageAttested) return json({ error: "age_attestation_required" }, 400);

    const captcha = await verifyTurnstile(env, turnstileToken, clientIp(request));
    if (!captcha.ok) return json({ error: "captcha_failed", detail: captcha.reason }, 403);

    const existing = await env.DB.prepare(
        "SELECT id, state, dashboard_token FROM users WHERE lower(email) = ?1 AND deleted_at IS NULL"
    ).bind(email).first();

    if (existing && existing.state === "active") {
        return json({
            error: "already_registered",
            dashboard_url: `/dashboard.html?t=${existing.dashboard_token}`,
        }, 409);
    }

    const nowIso = now();
    const expiresAt = new Date(Date.now() + 7 * 864e5).toISOString();
    const code = await uniqueCode(env);

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
            null, { email_lower: email, ip_hash: await ipHash(clientIp(request)) });

        return json({
            ok: true,
            dashboard_url: `/dashboard.html?t=${existing.dashboard_token}`,
            verification_code: code,
            expires_at: expiresAt,
        });
    }

    const userId = ulid();
    const dashboardToken = randomToken();

    await env.DB.prepare(`
        INSERT INTO users (id, email, legal_name, verification_code, code_expires_at,
                           dashboard_token, state, legal_name_attested, age_attested_13plus,
                           tos_version_accepted, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending_verification', 1, 1, ?7, ?8)
    `).bind(userId, email, legalName, code, expiresAt, dashboardToken, tosVersion, nowIso).run();

    await audit(env, "user", userId, "registration_created", "user", userId, null, {
        email_lower: email, ip_hash: await ipHash(clientIp(request)),
    });

    return json({
        ok: true,
        dashboard_url: `/dashboard.html?t=${dashboardToken}`,
        verification_code: code,
        expires_at: expiresAt,
    });
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
