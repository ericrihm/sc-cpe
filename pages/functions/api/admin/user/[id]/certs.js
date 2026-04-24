import { json, isAdmin } from "../../../../_lib.js";

export async function onRequestGet({ params, request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }
    const userId = params.id;
    if (!userId || userId.length < 10) {
        return json({ error: "invalid_user_id" }, 400);
    }

    const { results = [] } = await env.DB.prepare(`
        SELECT id, public_token, period_yyyymm, cert_kind, stream_id,
               cpe_total, sessions_count, state, revoked_at,
               revocation_reason, created_at, supersedes_cert_id
          FROM certs
         WHERE user_id = ?1
      ORDER BY created_at DESC
    `).bind(userId).all();

    return json({ ok: true, user_id: userId, count: results.length, certs: results });
}
