import {
    json, isAdmin, isValidEmail, audit, clientIp, ipHash,
    emailShell, queueEmail, ulid,
} from "../../../_lib.js";
import { buildMagicLinkToken, MAGIC_LINK_MAX_AGE } from "./_auth_helpers.js";

export async function onRequestGet({ request, env }) {
    const admin = await isAdmin(env, request);
    if (!admin) return json({ error: "unauthorized" }, 401);

    const rows = await env.DB.prepare(
        "SELECT id, email, role, display_name, created_at FROM admin_users ORDER BY id"
    ).all();

    const passkeys = await env.DB.prepare(
        "SELECT admin_id, COUNT(*) as count FROM admin_passkeys GROUP BY admin_id"
    ).all();
    const pkMap = {};
    for (const r of (passkeys.results || [])) pkMap[r.admin_id] = r.count;

    return json({
        ok: true,
        admins: (rows.results || []).map(r => ({
            id: r.id,
            email: r.email,
            role: r.role,
            display_name: r.display_name,
            created_at: r.created_at,
            passkey_count: pkMap[r.id] || 0,
        })),
        your_role: admin.role,
    });
}

export async function onRequestPost({ request, env }) {
    const admin = await isAdmin(env, request);
    if (!admin) return json({ error: "unauthorized" }, 401);
    if (admin.role !== "owner") return json({ error: "owner_only" }, 403);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const email = (body.email || "").trim().toLowerCase();
    const role = body.role || "admin";
    const displayName = (body.display_name || "").trim() || null;

    if (!isValidEmail(email)) return json({ error: "invalid_email" }, 400);
    if (role !== "admin" && role !== "owner") return json({ error: "invalid_role" }, 400);

    const existing = await env.DB.prepare(
        "SELECT id FROM admin_users WHERE lower(email) = ?1"
    ).bind(email).first();
    if (existing) return json({ error: "already_exists" }, 409);

    await env.DB.prepare(
        `INSERT INTO admin_users (email, role, display_name, invited_by, created_by)
         VALUES (?1, ?2, ?3, ?4, 'invite')`
    ).bind(email, role, displayName, admin.id).run();

    const newAdmin = await env.DB.prepare(
        "SELECT id, email, role FROM admin_users WHERE lower(email) = ?1"
    ).bind(email).first();

    if (env.ADMIN_COOKIE_SECRET) {
        const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
            .map(b => b.toString(16).padStart(2, "0")).join("");
        const expires = Date.now() + MAGIC_LINK_MAX_AGE;
        await env.RATE_KV.put("admin_nonce:" + nonce, email, { expirationTtl: 900 });
        const token = await buildMagicLinkToken(email, expires, nonce, env.ADMIN_COOKIE_SECRET);
        const siteBase = new URL(request.url).origin;
        const callbackUrl = siteBase + "/api/admin/auth/callback?token=" +
            encodeURIComponent(token) + "&redirect=" + encodeURIComponent("/admin.html");

        const bodyHtml =
            "<p>You've been invited to the SC-CPE admin panel.</p>" +
            '<p><a href="' + callbackUrl + '"' +
            ' style="display:inline-block;background:#0b3d5c;color:#fff;' +
            'padding:10px 16px;border-radius:4px;text-decoration:none;">' +
            "Accept Invite &amp; Sign In</a></p>" +
            '<p style="color:#666;font-size:12px;">This link expires in 15 minutes. ' +
            "After signing in you can set up a passkey for instant access.</p>";

        await queueEmail(env, {
            userId: null,
            template: "admin_invite",
            to: email,
            subject: "SC-CPE Admin Invite",
            html: emailShell({
                title: "Admin Invite",
                preheader: "You've been invited to the SC-CPE admin panel",
                bodyHtml,
            }),
            text: "You've been invited to the SC-CPE admin panel.\n\n" +
                  "Sign in: " + callbackUrl + "\n\nThis link expires in 15 minutes.",
            idempotencyKey: "admin_invite:" + ulid(),
        });
    }

    const ip = clientIp(request);
    const ipH = await ipHash(ip);
    await audit(
        env, "admin", admin.id, "admin_invited", "admin_user", newAdmin.id,
        null, { email, role },
        { ip_hash: ipH },
    );

    return json({ ok: true, admin: { id: newAdmin.id, email, role, display_name: displayName } });
}

export async function onRequestDelete({ request, env }) {
    const admin = await isAdmin(env, request);
    if (!admin) return json({ error: "unauthorized" }, 401);
    if (admin.role !== "owner") return json({ error: "owner_only" }, 403);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const targetId = body.admin_id;
    if (targetId == null) return json({ error: "missing_admin_id" }, 400);

    if (targetId === admin.id) return json({ error: "cannot_remove_self" }, 400);

    const target = await env.DB.prepare(
        "SELECT id, email, role FROM admin_users WHERE id = ?1"
    ).bind(targetId).first();
    if (!target) return json({ error: "not_found" }, 404);

    await env.DB.prepare("DELETE FROM admin_passkeys WHERE admin_id = ?1").bind(targetId).run();
    await env.DB.prepare("DELETE FROM admin_users WHERE id = ?1").bind(targetId).run();

    const ip = clientIp(request);
    const ipH = await ipHash(ip);
    await audit(
        env, "admin", admin.id, "admin_removed", "admin_user", targetId,
        null, { email: target.email, role: target.role },
        { ip_hash: ipH },
    );

    return json({ ok: true });
}
