import { json, isAdmin, audit, clientIp, ipHash, KILL_SWITCHES } from "../../_lib.js";

// GET  /api/admin/toggles  → { ok, toggles: [{name, killed}, ...] }
// POST /api/admin/toggles  body { name: "<one of KILL_SWITCHES>", killed: bool }
//
// Emergency-containment controls for public unauthenticated endpoints
// (register, recover, preflight). Killing a toggle makes the endpoint
// return 503 {error:"service_temporarily_unavailable"} until an operator
// clears it. No TTL — admin must explicitly re-enable.
//
// Critical-path endpoints (health, verify, download, dashboard reads,
// delete) are intentionally NOT killable so a user locked out by a
// launch-day misconfiguration can still access their data.

function assertKnown(name) {
    return KILL_SWITCHES.includes(name);
}

export async function onRequestGet({ request, env }) {
    if (!(await isAdmin(env, request))) return json({ error: "unauthorized" }, 401);
    if (!env.RATE_KV) {
        return json({
            ok: true,
            toggles: KILL_SWITCHES.map(n => ({ name: n, killed: false, kv_bound: false })),
        });
    }
    const states = await Promise.all(KILL_SWITCHES.map(async (name) => ({
        name,
        killed: !!(await env.RATE_KV.get(`kill:${name}`)),
    })));
    return json({ ok: true, toggles: states });
}

export async function onRequestPost({ request, env }) {
    if (!(await isAdmin(env, request))) return json({ error: "unauthorized" }, 401);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const name = String(body?.name || "");
    const killed = body?.killed === true;
    if (!assertKnown(name)) {
        return json({ error: "unknown_switch", known: KILL_SWITCHES }, 400);
    }
    if (!env.RATE_KV) {
        return json({ error: "kv_unbound", detail: "RATE_KV not bound — toggles unavailable" }, 503);
    }

    if (killed) {
        // No TTL — operator must explicitly clear. A forgotten kill is
        // preferable to an abuse burst returning on TTL expiry.
        await env.RATE_KV.put(`kill:${name}`, "1");
    } else {
        await env.RATE_KV.delete(`kill:${name}`);
    }

    await audit(
        env, "admin", null, "kill_switch_toggled",
        "kill_switch", name,
        null,
        { name, killed },
        { ip_hash: await ipHash(clientIp(request)) },
    );

    return json({ ok: true, name, killed });
}
