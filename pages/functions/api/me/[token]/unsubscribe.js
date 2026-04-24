import { json, isValidToken } from "../../../_lib.js";

// GET  /api/me/{token}/unsubscribe?cat=<category>  → HTML confirmation page
// POST /api/me/{token}/unsubscribe?cat=<category>  → one-click unsubscribe (RFC 8058)
//
// Categories that can be unsubscribed (engagement emails only):
//   monthly_digest, cert_nudge, renewal_nudge, streak_milestone
//
// Transactional emails (register, account_deleted, appeal_denied, cert_resend,
// admin_login) cannot be unsubscribed — they are required for account operation.
//
// No CSRF gate: the token in the URL authenticates the request, and the action
// is low-risk (opt-out, not opt-in). One-click unsubscribe per RFC 8058 must
// work without cookies or Origin headers.

const CATEGORIES = ["monthly_digest", "cert_nudge", "renewal_nudge", "streak_milestone"];

function parseCategory(request) {
    const url = new URL(request.url);
    const cat = url.searchParams.get("cat");
    if (!cat || !CATEGORIES.includes(cat)) return null;
    return cat;
}

const LABELS = {
    monthly_digest: "Monthly Digest",
    cert_nudge: "Certificate Reminders",
    renewal_nudge: "Renewal Reminders",
    streak_milestone: "Streak Milestones",
};

export async function onRequestGet({ params, request, env }) {
    const token = params.token;
    if (!isValidToken(token)) return json({ error: "invalid_token" }, 400);

    const cat = parseCategory(request);
    if (!cat) return json({ error: "invalid_category", valid: CATEGORIES }, 400);

    const user = await env.DB.prepare(
        "SELECT id FROM users WHERE dashboard_token = ?1 AND deleted_at IS NULL"
    ).bind(token).first();
    if (!user) return json({ error: "not_found" }, 404);

    const origin = new URL(request.url).origin;
    const postUrl = `${origin}/api/me/${token}/unsubscribe?cat=${cat}`;
    const label = LABELS[cat] || cat;
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe — SC-CPE</title>
<style>body{margin:0;padding:40px 20px;background:#f4f6f8;font-family:-apple-system,system-ui,sans-serif;color:#111;}
.card{max-width:440px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.1);}
h1{color:#0b3d5c;font-size:20px;margin:0 0 12px;}
p{color:#555;line-height:1.5;}
form{margin:20px 0 0;}
button{background:#0b3d5c;color:#fff;border:none;padding:12px 28px;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;}
button:hover{background:#0a2e47;}
.note{margin-top:16px;font-size:13px;color:#888;}</style></head>
<body><div class="card">
<h1>Unsubscribe from ${label}</h1>
<p>Click below to stop receiving <strong>${label.toLowerCase()}</strong> emails from SC-CPE.</p>
<form method="POST" action="${postUrl}">
<button type="submit">Unsubscribe</button>
</form>
<p class="note">You can re-enable this from your <a href="${origin}/dashboard.html?t=${token}">dashboard</a> settings.</p>
</div></body></html>`;

    return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
}

export async function onRequestPost({ params, request, env }) {
    const token = params.token;
    if (!isValidToken(token)) return json({ error: "invalid_token" }, 400);

    const cat = parseCategory(request);
    if (!cat) return json({ error: "invalid_category", valid: CATEGORIES }, 400);

    const user = await env.DB.prepare(
        "SELECT id, email_prefs FROM users WHERE dashboard_token = ?1 AND deleted_at IS NULL"
    ).bind(token).first();
    if (!user) return json({ error: "not_found" }, 404);

    let prefs = {};
    try { prefs = JSON.parse(user.email_prefs || "{}") || {}; } catch { prefs = {}; }

    if (!prefs.unsubscribed) prefs.unsubscribed = [];
    if (!prefs.unsubscribed.includes(cat)) {
        prefs.unsubscribed.push(cat);
    }

    await env.DB.prepare(
        "UPDATE users SET email_prefs = ?1 WHERE id = ?2"
    ).bind(JSON.stringify(prefs), user.id).run();

    const accept = request.headers.get("Accept") || "";
    if (accept.includes("text/html")) {
        const label = LABELS[cat] || cat;
        const origin = new URL(request.url).origin;
        const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribed — SC-CPE</title>
<style>body{margin:0;padding:40px 20px;background:#f4f6f8;font-family:-apple-system,system-ui,sans-serif;color:#111;}
.card{max-width:440px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.1);}
h1{color:#0b3d5c;font-size:20px;margin:0 0 12px;}
p{color:#555;line-height:1.5;}
.check{font-size:48px;margin-bottom:12px;}</style></head>
<body><div class="card">
<div class="check">&#10003;</div>
<h1>Unsubscribed</h1>
<p>You will no longer receive <strong>${label.toLowerCase()}</strong> emails.</p>
<p><a href="${origin}/dashboard.html?t=${token}">Return to dashboard</a></p>
</div></body></html>`;
        return new Response(html, {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
    }

    return json({ ok: true, unsubscribed: cat });
}
