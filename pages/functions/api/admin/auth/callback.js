import { audit, clientIp, ipHash } from "../../../_lib.js";
import {
    parseMagicLinkToken, buildSessionCookie,
    sessionCookieHeader, SESSION_MAX_AGE,
} from "./_auth_helpers.js";

function errorRedirect(redirectPath) {
    return new Response(null, {
        status: 302,
        headers: { Location: redirectPath + "?error=expired" },
    });
}

export async function onRequestGet({ request, env }) {
    const url = new URL(request.url);
    const tokenParam = url.searchParams.get("token");
    const redirectParam = url.searchParams.get("redirect") || "/admin.html";

    const safeRedirect = redirectParam.startsWith("/") && !redirectParam.startsWith("//")
        ? redirectParam
        : "/admin.html";

    if (!tokenParam || !env.ADMIN_COOKIE_SECRET) {
        return errorRedirect(safeRedirect);
    }

    const parsed = await parseMagicLinkToken(tokenParam, env.ADMIN_COOKIE_SECRET);
    if (!parsed) return errorRedirect(safeRedirect);

    const { email, nonce } = parsed;

    const nonceKey = "admin_nonce:" + nonce;
    const storedEmail = await env.RATE_KV.get(nonceKey);
    if (!storedEmail || storedEmail.toLowerCase() !== email.toLowerCase()) {
        return errorRedirect(safeRedirect);
    }
    await env.RATE_KV.delete(nonceKey);

    const admin = await env.DB.prepare(
        "SELECT id, email FROM admin_users WHERE lower(email) = ?1"
    ).bind(email.toLowerCase()).first();
    if (!admin) return errorRedirect(safeRedirect);

    const sessionExpires = Date.now() + SESSION_MAX_AGE;
    const cookieValue = await buildSessionCookie(email, sessionExpires, env.ADMIN_COOKIE_SECRET);

    const ip = clientIp(request);
    const ipH = await ipHash(ip);
    await audit(
        env, "admin", admin.id, "admin_login", "admin_user", admin.id,
        null, { method: "magic_link" },
        { ip_hash: ipH, user_agent: request.headers.get("User-Agent") || null },
    );

    return new Response(null, {
        status: 302,
        headers: {
            Location: safeRedirect,
            "Set-Cookie": sessionCookieHeader(cookieValue),
            "Cache-Control": "no-store",
        },
    });
}
