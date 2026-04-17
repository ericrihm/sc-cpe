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
    if (body?.renewal_tracker !== undefined) {
        if (body.renewal_tracker === null) {
            patch.renewal_tracker = null;
        } else {
            const rt = body.renewal_tracker;
            if (typeof rt !== "object" || Array.isArray(rt))
                return json({ error: "invalid_renewal_tracker" }, 400);
            if (typeof rt.cert_name !== "string" || rt.cert_name.length > 100)
                return json({ error: "invalid_cert_name" }, 400);
            if (typeof rt.deadline !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rt.deadline))
                return json({ error: "invalid_deadline" }, 400);
            const cpeReq = Number(rt.cpe_required);
            if (!Number.isFinite(cpeReq) || cpeReq < 1 || cpeReq > 9999)
                return json({ error: "invalid_cpe_required" }, 400);
            patch.renewal_tracker = {
                cert_name: rt.cert_name.trim().slice(0, 100),
                deadline: rt.deadline,
                cpe_required: cpeReq,
            };
        }
    }

    let leaderboardToggle;
    if (body?.show_on_leaderboard !== undefined) {
        if (typeof body.show_on_leaderboard !== "boolean") {
            return json({ error: "invalid_show_on_leaderboard" }, 400);
        }
        leaderboardToggle = body.show_on_leaderboard;
    }

    if (Object.keys(patch).length === 0 && leaderboardToggle === undefined) {
        return json({ error: "no_known_fields" }, 400);
    }

    const user = await env.DB.prepare(
        "SELECT id, email_prefs, show_on_leaderboard FROM users WHERE dashboard_token = ?1 AND deleted_at IS NULL"
    ).bind(token).first();
    if (!user) return json({ error: "not_found" }, 404);

    let current = {};
    try { current = JSON.parse(user.email_prefs || "{}") || {}; } catch { current = {}; }
    const merged = { ...current, ...patch };

    if (leaderboardToggle !== undefined) {
        await env.DB.prepare(
            "UPDATE users SET email_prefs = ?1, show_on_leaderboard = ?2 WHERE id = ?3"
        ).bind(JSON.stringify(merged), leaderboardToggle ? 1 : 0, user.id).run();
    } else {
        await env.DB.prepare(
            "UPDATE users SET email_prefs = ?1 WHERE id = ?2"
        ).bind(JSON.stringify(merged), user.id).run();
    }

    return json({
        ok: true,
        email_prefs: merged,
        show_on_leaderboard: leaderboardToggle !== undefined
            ? leaderboardToggle
            : !!user.show_on_leaderboard,
    });
}
