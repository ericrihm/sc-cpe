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
//   it's loaded on index.html and recover.html for bot mitigation.
// - frame-ancestors 'none' replaces X-Frame-Options (modern browsers prefer
//   CSP). We keep X-Frame-Options for the legacy-IE case.
// - HSTS is safe because every *.pages.dev origin is HTTPS-only.

const CSP = [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com https://cdnjs.cloudflare.com",
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

export async function onRequest({ request, next }) {
    const res = await next();
    const ct = res.headers.get("Content-Type") || "";

    // Applied to every response type.
    res.headers.set("X-Content-Type-Options", "nosniff");
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("Referrer-Policy", "no-referrer");
    res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
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
