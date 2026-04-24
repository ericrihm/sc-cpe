import { json, isAdmin, audit, clientIp, ipHash, rateLimit, sha256Hex } from "../../_lib.js";

function maskEmail(email) {
    const [local, domain] = email.split("@");
    if (!domain) return "***";
    return local.slice(0, 3) + "***@" + domain;
}

export async function onRequestGet({ request, env }) {
    if (!(await isAdmin(env, request))) return json({ error: "unauthorized" }, 401);

    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, `admin_supp:${ipH}`, 60);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    const rows = await env.DB.prepare(
        "SELECT email, reason, event_id, created_at FROM email_suppression ORDER BY created_at DESC LIMIT 100"
    ).all();

    const suppressions = (rows.results || []).map(r => ({
        email_masked: maskEmail(r.email),
        reason: r.reason,
        event_id: r.event_id,
        created_at: r.created_at,
    }));

    return json({ ok: true, suppressions });
}

export async function onRequestDelete({ request, env }) {
    if (!(await isAdmin(env, request))) return json({ error: "unauthorized" }, 401);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const email = (body?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return json({ error: "invalid_email" }, 400);

    const existing = await env.DB.prepare(
        "SELECT email FROM email_suppression WHERE email = ?1"
    ).bind(email).first();
    if (!existing) return json({ error: "not_found" }, 404);

    await env.DB.prepare("DELETE FROM email_suppression WHERE email = ?1").bind(email).run();

    await audit(env, "admin", null, "suppression_removed", "email",
        await sha256Hex(email), null, { reason: "admin_unsuppressed" },
        { ip_hash: await ipHash(clientIp(request)) });

    return json({ ok: true });
}
