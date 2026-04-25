const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford-ish, no I/O/L/U

export function ulid() {
    let ts = "", n = Date.now();
    for (let i = 9; i >= 0; i--, n = Math.floor(n / 32)) ts = A[n % 32] + ts;
    const rnd = crypto.getRandomValues(new Uint8Array(16));
    let r = "";
    for (let i = 0; i < 16; i++) r += A[rnd[i] % 32];
    return ts + r;
}

export function randomCode() {
    const rnd = crypto.getRandomValues(new Uint8Array(8));
    let s = "";
    for (let i = 0; i < 8; i++) s += CODE_ALPHA[rnd[i] % CODE_ALPHA.length];
    return s;
}

export function formatCode(raw) {
    return `SC-CPE{${raw.slice(0, 4)}-${raw.slice(4)}}`;
}

export function randomToken() {
    const rnd = crypto.getRandomValues(new Uint8Array(32));
    return [...rnd].map(b => b.toString(16).padStart(2, "0")).join("");
}

const HEX_RE = /^[0-9a-f]{64}$/;
export function isValidToken(t) { return typeof t === "string" && HEX_RE.test(t); }

export function json(obj, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            ...extraHeaders,
        },
    });
}

export function now() { return new Date().toISOString(); }

export function clientIp(request) {
    return request.headers.get("CF-Connecting-IP") || "0.0.0.0";
}

export async function ipHash(ip) {
    const buf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`sc-cpe|${ip}`),
    );
    return [...new Uint8Array(buf)].slice(0, 8)
        .map(b => b.toString(16).padStart(2, "0")).join("");
}

// Canonical serialisation for the audit hash chain. Must match the Python
// and Workers implementations exactly — any divergence breaks the chain.
// Array form (vs. object) sidesteps cross-runtime key-ordering ambiguity.
export function canonicalAuditRow(r) {
    return JSON.stringify([
        r.id, r.actor_type, r.actor_id ?? null, r.action,
        r.entity_type, r.entity_id,
        r.before_json ?? null, r.after_json ?? null,
        r.ip_hash ?? null, r.user_agent ?? null,
        r.ts, r.prev_hash ?? null,
    ]);
}

export async function sha256Hex(s) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Map free-text admin revocation reason to a public enum. Used at write
// time to keep PII (recipient names, allegation details) out of the
// append-only audit_log; also used at read time in the verify portal.
export function classifyRevocation(reason) {
    const r = String(reason || "").toLowerCase();
    if (/fraud|fake|forg|impersonat/.test(r)) return "issued_in_error";
    if (/duplicate|superseded|replaced|reissued/.test(r)) return "superseded";
    if (/withdraw|delete|gdpr|right to be forgotten/.test(r)) return "subject_request";
    if (/key|signing|cert/.test(r)) return "key_compromise";
    return "other";
}

// Insert a hash-chained audit row. Reads the current chain tip, computes
// prev_hash from it, INSERTs. On UNIQUE-index collision (two writers picked
// the same tip) retries up to MAX_ATTEMPTS. The partial unique index on
// prev_hash is what serialises concurrent writers; without it the chain can
// silently fork.
export async function audit(env, actorType, actorId, action, entityType, entityId, before, after, opts = {}) {
    const MAX_ATTEMPTS = 5;
    const row = {
        id: null,
        actor_type: actorType,
        actor_id: actorId ?? null,
        action,
        entity_type: entityType,
        entity_id: entityId,
        before_json: before == null ? null : JSON.stringify(before),
        after_json: after == null ? null : JSON.stringify(after),
        ip_hash: opts.ip_hash ?? null,
        user_agent: opts.user_agent ? opts.user_agent.slice(0, 500) : null,
        ts: null,
        prev_hash: null,
    };

    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const tip = await env.DB.prepare(
            `SELECT id, actor_type, actor_id, action, entity_type, entity_id,
                    before_json, after_json, ip_hash, user_agent, ts, prev_hash
             FROM audit_log ORDER BY ts DESC, id DESC LIMIT 1`,
        ).first();

        row.prev_hash = tip ? await sha256Hex(canonicalAuditRow(tip)) : null;
        row.id = ulid();
        row.ts = now();

        try {
            await env.DB.prepare(
                `INSERT INTO audit_log
                   (id, actor_type, actor_id, action, entity_type, entity_id,
                    before_json, after_json, ip_hash, user_agent, ts, prev_hash)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
            ).bind(
                row.id, row.actor_type, row.actor_id, row.action,
                row.entity_type, row.entity_id,
                row.before_json, row.after_json,
                row.ip_hash, row.user_agent, row.ts, row.prev_hash,
            ).run();
            return row.id;
        } catch (err) {
            lastErr = err;
            const msg = String(err && err.message || err);
            if (!/UNIQUE/i.test(msg)) throw err;
            // Contention on tip — back off briefly and retry with refreshed tip.
            await new Promise(r => setTimeout(r, 10 + Math.floor(Math.random() * 40)));
        }
    }
    throw new Error(`audit chain contention: ${MAX_ATTEMPTS} attempts failed: ${lastErr}`);
}

// Same-origin gate for state-changing POSTs. The dashboard token sits in
// query strings and can leak via Referer / forwarded URLs; without an
// Origin check, any third-party site that knows a victim's dashboard URL
// can cross-post-fetch /api/me/[token]/{delete,resend-code} and act on
// their behalf. Browsers always send Origin on cross-origin POSTs, so
// rejecting null/mismatched values is a sound baseline. Allow-list extra
// origins through env.ALLOWED_ORIGINS (comma-separated) for staging/dev.
export function isSameOrigin(request, env) {
    const origin = request.headers.get("Origin");
    if (!origin) return false;
    const url = new URL(request.url);
    const expected = `${url.protocol}//${url.host}`;
    if (origin === expected) return true;
    const extra = (env?.ALLOWED_ORIGINS || "")
        .split(",").map(s => s.trim()).filter(Boolean);
    return extra.includes(origin);
}

// Known kill switches. Endpoints check `await killSwitched(env, name)` at
// entry and return 503 if the switch is set. Used to contain launch-day
// abuse bursts without taking the whole service down. Only the public,
// unauthenticated, abuse-prone endpoints are killable — dashboard reads,
// cert verification, cert download, user deletion, and admin paths stay
// on even under a kill so legit users can still access their data.
export const KILL_SWITCHES = Object.freeze(["register", "recover", "preflight"]);

export async function killSwitched(env, name) {
    if (!env.RATE_KV) return false;  // KV-gated, same store as rateLimit
    return !!(await env.RATE_KV.get(`kill:${name}`));
}

export function killedResponse() {
    return json({
        error: "service_temporarily_unavailable",
        reason: "admin_kill_switch",
    }, 503);
}

// Per-key rate limiter that fails *closed* if the KV binding is missing.
// Earlier this returned `false` (no limit) on missing binding, which made
// the limit silently disappear in any environment that hadn't bound the
// namespace. Returns { ok: true } when allowed, { ok: false, status, body }
// when the caller should short-circuit.
export async function rateLimit(env, key, max, ttlSec = 3700) {
    if (!env.RATE_KV) {
        // No binding = no enforcement = vector. Refuse the request rather
        // than silently turning the limiter off.
        console.error("rateLimit:RATE_KV_unbound", { key });
        return { ok: false, status: 503, body: { error: "rate_limiter_unavailable" } };
    }
    const current = parseInt(await env.RATE_KV.get(key), 10) || 0;
    const headers = {
        "X-RateLimit-Limit": String(max),
        "X-RateLimit-Remaining": String(Math.max(0, max - current - 1)),
        "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + ttlSec),
    };
    if (current >= max) {
        const bucket = new Date().toISOString().slice(0, 13);
        const evtKey = `sec:rl_trip:${key.split(":")[0]}:${bucket}`;
        env.RATE_KV.put(evtKey, String((parseInt(await env.RATE_KV.get(evtKey), 10) || 0) + 1),
            { expirationTtl: 86400 }).catch(() => {});
        headers["X-RateLimit-Remaining"] = "0";
        headers["Retry-After"] = String(ttlSec);
        return { ok: false, status: 429, body: { error: "rate_limited" }, headers };
    }
    await env.RATE_KV.put(key, String(current + 1), { expirationTtl: ttlSec });
    return { ok: true, headers };
}

export async function securityEvent(env, category, detail) {
    if (!env.RATE_KV) return;
    const bucket = new Date().toISOString().slice(0, 13);
    const key = `sec:${category}:${bucket}`;
    const cur = parseInt(await env.RATE_KV.get(key), 10) || 0;
    await env.RATE_KV.put(key, String(cur + 1), { expirationTtl: 86400 });
}

// SQLite LIKE wildcards `%` and `_` (and the `\` we use to escape them)
// must be neutralised when the user-supplied substring is interpolated
// into a `LIKE ?1 ESCAPE '\'` clause. Without this, a 1-char query of
// `_` matches every row and quietly turns the admin search into a
// "list everyone" oracle.
export function escapeLike(s) {
    return String(s).replace(/[\\%_]/g, c => "\\" + c);
}

export function isValidEmail(s) {
    if (!s || s.length > 254) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function isValidName(s) {
    if (!s || s.length < 2 || s.length > 100) return false;
    if (/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u.test(s)) return false;
    return /[\p{L}]/u.test(s);
}

// CPE-per-attended-day. The poller reads this from the kv table at every
// tick; manual grants (admin/attendance.js, appeals/[id]/resolve.js) used
// to hardcode 0.5 and would silently drift if the rule was retuned. Both
// paths now share this helper so admin grants and poller grants always
// produce the same earned_cpe for the active rule version.
export async function getCpePerDay(env, ruleVersion) {
    const v = parseInt(ruleVersion, 10) || 1;
    const row = await env.DB.prepare(
        "SELECT v FROM kv WHERE k = ?1"
    ).bind(`rule_version.${v}.cpe_per_day`).first();
    const parsed = parseFloat(row?.v);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.5;
}

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

export function emailButton(text, url) {
    return `<p style="text-align:center;margin:24px 0;">
  <a href="${url}" style="display:inline-block;background:#d4a73a;color:#0b3d5c;
     font-weight:bold;padding:12px 28px;border-radius:6px;text-decoration:none;
     font-size:14px;letter-spacing:0.02em;">${escapeHtml(text)}</a>
</p>`;
}

export function emailCode(code) {
    return `<div style="text-align:center;margin:20px 0;">
  <div style="display:inline-block;background:#0b3d5c;color:#d4a73a;
       font-family:Menlo,Consolas,monospace;font-size:22px;font-weight:bold;
       padding:14px 28px;border-radius:8px;letter-spacing:0.06em;">
       ${escapeHtml(code)}</div>
</div>`;
}

export function emailProgress(pct) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    return `<div style="margin:16px 0;">
  <div style="background:#e6eaee;border-radius:8px;height:20px;overflow:hidden;">
    <div style="background:linear-gradient(90deg,#0b3d5c,#d4a73a);
         width:${clamped}%;height:100%;border-radius:8px;"></div>
  </div>
  <div style="text-align:center;font-size:13px;color:#555;margin-top:4px;">
    ${clamped}% complete</div>
</div>`;
}

export function emailDivider() {
    return `<hr style="border:none;border-top:1px solid #e6eaee;margin:20px 0;">`;
}

export function emailShell({ title, preheader = "", bodyHtml, siteBase = "https://sc-cpe-web.pages.dev", unsubscribeUrl }) {
    const safeTitle = escapeHtml(title);
    const unsub = unsubscribeUrl
        ? `<br/><a href="${unsubscribeUrl}" style="color:#777;">Unsubscribe</a> from these emails.`
        : "";
    return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f6f8;font-family:Helvetica,Arial,sans-serif;color:#111;line-height:1.5;">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(preheader)}</span>
<div style="max-width:580px;margin:0 auto;background:#fff;">
  <div style="background:#0b3d5c;padding:18px 24px;">
    <div style="color:#fff;font-size:11pt;letter-spacing:0.18em;text-transform:uppercase;">Simply Cyber CPE</div>
    <div style="color:#d4a73a;font-size:9pt;margin-top:2px;">${safeTitle}</div>
  </div>
  <div style="padding:24px;">
    ${bodyHtml}
  </div>
  <div style="padding:16px 24px;border-top:1px solid #e6eaee;font-size:11px;color:#777;">
    You're receiving this because you registered at
    <a href="${siteBase}" style="color:#777;">Simply Cyber CPE</a>.${unsub}<br/>
    Questions? Reply to this email.
  </div>
</div>
</body></html>`;
}

export function isUnsubscribed(emailPrefsJson, category) {
    try {
        const prefs = JSON.parse(emailPrefsJson || "{}") || {};
        return Array.isArray(prefs.unsubscribed) && prefs.unsubscribed.includes(category);
    } catch { return false; }
}

export function unsubscribeUrl(siteBase, dashboardToken, category) {
    return `${siteBase}/api/me/${dashboardToken}/unsubscribe?cat=${category}`;
}

export function unsubscribeHeaders(siteBase, dashboardToken, category) {
    const url = unsubscribeUrl(siteBase, dashboardToken, category);
    return {
        "List-Unsubscribe": `<${url}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
}

// Insert a row into email_outbox. The email-sender Worker (polls every
// 2 min) is responsible for actually dispatching via Resend. `template`
// is a tag for analytics; payload_json must carry html_body and/or
// text_body — the drainer does not re-render. `idempotencyKey` must be
// stable for the logical event (e.g. "register:<userId>:<code>") so a
// producer retry on the same event doesn't duplicate the email.
export async function queueEmail(env, { userId, template, to, subject, html, text, idempotencyKey, headers }) {
    const payloadObj = { html_body: html, text_body: text };
    if (headers) payloadObj.headers = headers;
    const payload = JSON.stringify(payloadObj);
    try {
        await env.DB.prepare(`
            INSERT INTO email_outbox
              (id, user_id, template, to_email, subject, payload_json,
               idempotency_key, state, attempts, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', 0, ?8)
        `).bind(
            ulid(), userId ?? null, template, to, subject, payload,
            idempotencyKey, now(),
        ).run();
        return { queued: true };
    } catch (err) {
        // UNIQUE(idempotency_key) means a retry hits this path; treat as
        // success so callers don't error on legitimate re-registers.
        const msg = String(err?.message || err);
        if (/UNIQUE/i.test(msg)) return { queued: false, duplicate: true };
        throw err;
    }
}

export async function isAdmin(env, request) {
    const expected = env.ADMIN_TOKEN;
    const h = request.headers.get("Authorization") || "";
    const bearerMatch = /^Bearer\s+(.+)$/i.test(h) && h.replace(/^Bearer\s+/i, "");
    if (bearerMatch && expected) {
        const given = bearerMatch;
        const enc = new TextEncoder();
        const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
        const key = await crypto.subtle.importKey(
            "raw", keyMaterial, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
        );
        const a = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(given)));
        const b = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(expected)));
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        if (diff !== 0) {
            securityEvent(env, "auth_fail:bearer", "").catch(() => {});
            return false;
        }
        return { id: 0, email: "__bearer__", role: "owner" };
    }

    if (!env.ADMIN_COOKIE_SECRET) return false;
    const { parseSessionCookie, parseCookies, COOKIE_NAME } = await import(
        "./api/admin/auth/_auth_helpers.js"
    );
    const cookies = parseCookies(request.headers.get("Cookie"));
    const cookieValue = cookies[COOKIE_NAME];
    if (!cookieValue) return false;
    const session = await parseSessionCookie(cookieValue, env.ADMIN_COOKIE_SECRET);
    if (!session) return false;
    const admin = await env.DB.prepare(
        "SELECT id, email, role FROM admin_users WHERE lower(email) = ?1"
    ).bind(session.email.toLowerCase()).first();
    return admin || false;
}

export async function constantTimeEqual(a, b) {
    const enc = new TextEncoder();
    const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey(
        "raw", keyMaterial, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const da = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(a)));
    const db = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(b)));
    let diff = 0;
    for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
    return diff === 0;
}

export async function verifyTurnstile(env, token, ip) {
    if (!env.TURNSTILE_SECRET_KEY) {
        // Dev/local: allow if secret isn't configured, but log it.
        console.warn("TURNSTILE_SECRET_KEY unset — skipping verification");
        return { ok: true, reason: "dev_skip" };
    }
    if (!token) return { ok: false, reason: "missing_token" };
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET_KEY);
    form.append("response", token);
    form.append("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: form,
    });
    const data = await res.json();
    return { ok: !!data.success, reason: (data["error-codes"] || []).join(",") };
}
