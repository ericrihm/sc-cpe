import { json, isAdmin, audit, clientIp, ipHash } from "../../../_lib.js";

export async function onRequestGet({ request, env }) {
    const admin = await isAdmin(env, request);
    if (!admin) return json({ error: "unauthorized" }, 401);

    const rows = await env.DB.prepare(
        "SELECT id, credential_id, backed_up, created_at, last_used_at FROM admin_passkeys WHERE admin_id = ?1 ORDER BY created_at"
    ).bind(admin.id).all();

    return json({
        ok: true,
        passkeys: (rows.results || []).map(r => ({
            id: r.id,
            credential_id_prefix: r.credential_id.slice(0, 16),
            backed_up: !!r.backed_up,
            created_at: r.created_at,
            last_used_at: r.last_used_at,
        })),
    });
}

export async function onRequestDelete({ request, env }) {
    const admin = await isAdmin(env, request);
    if (!admin) return json({ error: "unauthorized" }, 401);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const passkeyId = body.passkey_id;
    if (!passkeyId) return json({ error: "missing_passkey_id" }, 400);

    const row = await env.DB.prepare(
        "SELECT id, credential_id FROM admin_passkeys WHERE id = ?1 AND admin_id = ?2"
    ).bind(passkeyId, admin.id).first();
    if (!row) return json({ error: "not_found" }, 404);

    await env.DB.prepare("DELETE FROM admin_passkeys WHERE id = ?1").bind(passkeyId).run();

    const ip = clientIp(request);
    const ipH = await ipHash(ip);
    await audit(
        env, "admin", admin.id, "passkey_removed", "admin_passkey", passkeyId,
        null, { credential_id_prefix: row.credential_id.slice(0, 16) },
        { ip_hash: ipH },
    );

    return json({ ok: true });
}
