import { json, isSameOrigin } from "../../../_lib.js";

// POST /api/me/{token}/prefs
// Body: { "cert_style"?: "bundled"|"per_session"|"both",
//          "monthly_cert"?: boolean }
//
// Patches users.email_prefs (JSON). Only keys the endpoint knows about are
// writable; unknown keys are silently dropped so a future field can't be
// poisoned via stale client code.
//
// CSRF gate: dashboard_token sits in URL → Origin check required.
export async function onRequestPost({ params, request, env }) {
    const token = params.token;
    if (!token || token.length < 32) return json({ error: "invalid_token" }, 400);
    if (!isSameOrigin(request, env)) return json({ error: "forbidden_origin" }, 403);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const patch = {};
    if (body?.cert_style !== undefined) {
        if (!["bundled", "per_session", "both"].includes(body.cert_style)) {
            return json({ error: "invalid_cert_style" }, 400);
        }
        patch.cert_style = body.cert_style;
    }
    if (body?.monthly_cert !== undefined) {
        if (typeof body.monthly_cert !== "boolean") {
            return json({ error: "invalid_monthly_cert" }, 400);
        }
        patch.monthly_cert = body.monthly_cert;
    }
    if (Object.keys(patch).length === 0) {
        return json({ error: "no_known_fields" }, 400);
    }

    const user = await env.DB.prepare(
        "SELECT id, email_prefs FROM users WHERE dashboard_token = ?1 AND deleted_at IS NULL"
    ).bind(token).first();
    if (!user) return json({ error: "not_found" }, 404);

    let current = {};
    try { current = JSON.parse(user.email_prefs || "{}") || {}; } catch { current = {}; }
    const merged = { ...current, ...patch };
    await env.DB.prepare(
        "UPDATE users SET email_prefs = ?1 WHERE id = ?2"
    ).bind(JSON.stringify(merged), user.id).run();

    return json({ ok: true, email_prefs: merged });
}
