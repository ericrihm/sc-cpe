// Security headers middleware. Applies to every Pages response (including
// static HTML, JSON APIs, and function output) so the admin dashboard and
// user-facing flows share one policy.
//
// Design notes:
// - All inline scripts have been extracted to external files, so script-src
//   no longer needs 'unsafe-inline'. style-src retains 'unsafe-inline'
//   because HTML templates use style= attributes extensively; removing those
//   would be a larger refactor with minimal security benefit since style
//   injection is not an XSS vector.
// - Turnstile (https://challenges.cloudflare.com) is explicitly allowed —
//   it's loaded on index.html, dashboard.html, and admin pages for bot mitigation.
// - frame-ancestors 'none' replaces X-Frame-Options (modern browsers prefer
//   CSP). We keep X-Frame-Options for the legacy-IE case.
// - HSTS is safe because every *.pages.dev origin is HTTPS-only.

const CSP = [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com https://cdnjs.cloudflare.com/ajax/libs/jszip/",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
    "report-uri /api/csp-report",
].join("; ");

const PERMISSIONS = [
    "accelerometer=()",
    "camera=()",
    "geolocation=()",
    "gyroscope=()",
    "magnetometer=()",
    "microphone=()",
    "payment=()",
    "usb=()",
].join(", ");

const HONEYPOT_RE = /^\/(wp-admin|wp-login|xmlrpc|admin\.php|\.env|\.git|\.svn|\.DS_Store|phpmyadmin|cgi-bin|shell|eval-stdin|vendor\/phpunit|_profiler|actuator|debug|telescope|config\.json|server-status)/i;

export async function onRequest({ request, next, env }) {
    const url = new URL(request.url);
    if (HONEYPOT_RE.test(url.pathname)) {
        if (env.RATE_KV) {
            const bucket = new Date().toISOString().slice(0, 13);
            const key = `sec:honeypot:${bucket}`;
            const cur = parseInt(await env.RATE_KV.get(key), 10) || 0;
            env.RATE_KV.put(key, String(cur + 1), { expirationTtl: 86400 }).catch(() => {});
            if (cur < 100) {
                const ip = request.headers.get("CF-Connecting-IP") || "?";
                const ua = (request.headers.get("User-Agent") || "?").slice(0, 200);
                env.RATE_KV.put(`honeypot_log:${bucket}:${cur}`, JSON.stringify({
                    path: url.pathname.slice(0, 200), ip_prefix: ip.split(".").slice(0, 2).join(".") + ".*",
                    ua, ts: new Date().toISOString(),
                }), { expirationTtl: 86400 }).catch(() => {});
            }
        }
        return new Response("", { status: 404 });
    }

    const res = await next();
    const ct = res.headers.get("Content-Type") || "";

    const requestId = request.headers.get("cf-ray")
        || crypto.randomUUID();
    res.headers.set("X-Request-Id", requestId);

    // Applied to every response type.
    res.headers.set("X-Content-Type-Options", "nosniff");
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("Referrer-Policy", "no-referrer");
    res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    res.headers.set("Permissions-Policy", PERMISSIONS);
    res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    res.headers.set("Cross-Origin-Resource-Policy", "same-origin");

    // CSP only meaningful for HTML responses — setting it on PDF / JSON wastes
    // bytes and occasionally breaks SDK clients that parse headers strictly.
    if (ct.includes("text/html")) {
        res.headers.set("Content-Security-Policy", CSP);
    }

    return res;
}
