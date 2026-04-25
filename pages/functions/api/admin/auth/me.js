import { json, isAdmin } from "../../../_lib.js";

export async function onRequestGet({ request, env }) {
    const admin = await isAdmin(env, request);
    if (!admin) return json({ error: "unauthorized" }, 401);

    const passkeys = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM admin_passkeys WHERE admin_id = ?1"
    ).bind(admin.id).first();

    return json({
        ok: true,
        id: admin.id,
        email: admin.email,
        role: admin.role,
        passkey_count: passkeys ? passkeys.count : 0,
    });
}
