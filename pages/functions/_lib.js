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

export function randomToken() {
    const rnd = crypto.getRandomValues(new Uint8Array(32));
    return [...rnd].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
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
        user_agent: opts.user_agent ?? null,
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

// Shared email chrome. All user-facing emails (register, cert delivery,
// resend, recovery) pass through this so the navy header, footer, and
// deliverability boilerplate stay consistent. bodyHtml must already be
// escaped where needed; preheader is the grey preview-pane text.
export function emailShell({ title, preheader = "", bodyHtml }) {
    const safeTitle = escapeHtml(title);
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
    You're receiving this because you registered for Simply Cyber CPE.<br/>
    Questions? Reply to this email.
  </div>
</div>
</body></html>`;
}

// Insert a row into email_outbox. The email-sender Worker (polls every
// 2 min) is responsible for actually dispatching via Resend. `template`
// is a tag for analytics; payload_json must carry html_body and/or
// text_body — the drainer does not re-render. `idempotencyKey` must be
// stable for the logical event (e.g. "register:<userId>:<code>") so a
// producer retry on the same event doesn't duplicate the email.
export async function queueEmail(env, { userId, template, to, subject, html, text, idempotencyKey }) {
    const payload = JSON.stringify({ html_body: html, text_body: text });
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

// Constant-time bearer-token check for admin endpoints. env.ADMIN_TOKEN
// is set via `wrangler pages secret put ADMIN_TOKEN`. Returns true if the
// Authorization header matches.
export async function isAdmin(env, request) {
    const expected = env.ADMIN_TOKEN;
    if (!expected) return false;
    const h = request.headers.get("Authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    const given = m[1];
    if (given.length !== expected.length) return false;
    const a = new TextEncoder().encode(given);
    const b = new TextEncoder().encode(expected);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
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
