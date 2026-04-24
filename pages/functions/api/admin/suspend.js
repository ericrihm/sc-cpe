import { json, isAdmin, audit, clientIp, ipHash, now, rateLimit } from "../../_lib.js";

export async function onRequestPost({ request, env }) {
    if (!(await isAdmin(env, request))) return json({ error: "unauthorized" }, 401);

    const rl = await rateLimit(env, `admin_suspend:${await ipHash(clientIp(request))}`, 30);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const userId = (body?.user_id || "").trim();
    const suspended = body?.suspended === true;
    const reason = (body?.reason || "").trim();

    if (!userId || userId.length > 40) return json({ error: "invalid_user_id" }, 400);
    if (!reason || reason.length > 500) return json({ error: "reason_required_under_500_chars" }, 400);

    const user = await env.DB.prepare(
        "SELECT id, state, suspended_at FROM users WHERE id = ?1 AND deleted_at IS NULL"
    ).bind(userId).first();
    if (!user) return json({ error: "not_found" }, 404);

    const ts = now();
    if (suspended) {
        await env.DB.prepare(
            "UPDATE users SET suspended_at = ?1 WHERE id = ?2"
        ).bind(ts, userId).run();
        await audit(env, "admin", null, "user_suspended", "user", userId,
            { suspended_at: user.suspended_at },
            { suspended_at: ts, reason },
            { ip_hash: await ipHash(clientIp(request)) });
    } else {
        await env.DB.prepare(
            "UPDATE users SET suspended_at = NULL WHERE id = ?1"
        ).bind(userId).run();
        await audit(env, "admin", null, "user_unsuspended", "user", userId,
            { suspended_at: user.suspended_at },
            { suspended_at: null, reason },
            { ip_hash: await ipHash(clientIp(request)) });
    }

    return json({ ok: true, user_id: userId, suspended_at: suspended ? ts : null });
}
