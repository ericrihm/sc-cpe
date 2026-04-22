# Admin Magic-Link Auth + Dashboard Sign-In UX Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the admin token paste-in with email magic-link login, and replace the "recover" flow with a friendlier sign-in experience on the dashboard page.

**Architecture:** New `admin_users` D1 table + three auth endpoints (`login`, `callback`, `logout`). `isAdmin()` gains a cookie path (HMAC-signed `__Host-sc-admin` cookie) alongside the existing bearer path. User-facing "recover" page is removed; its sign-in form moves to `/dashboard.html` with polished copy.

**Tech Stack:** Cloudflare Pages Functions (JS), D1 (SQLite), KV (nonce TTL), Web Crypto API (HMAC-SHA256), existing email_outbox + Resend.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `db/migrations/009_admin_users.sql` | Create | `admin_users` table + seed row |
| `pages/functions/api/admin/auth/_auth_helpers.js` | Create | Token signing, cookie parsing, nonce helpers |
| `pages/functions/api/admin/auth/_auth_helpers.test.mjs` | Create | Tests for signing/parsing helpers |
| `pages/functions/api/admin/auth/login.js` | Create | POST endpoint — queue magic-link email |
| `pages/functions/api/admin/auth/callback.js` | Create | GET endpoint — verify token, set cookie |
| `pages/functions/api/admin/auth/logout.js` | Create | POST endpoint — clear cookie |
| `pages/functions/_lib.js` | Modify | Update `isAdmin()` to support cookie path |
| `pages/admin.html` | Modify | Replace token input with email login form |
| `pages/admin.js` | Modify | Cookie-based auth detection, sign-out button |
| `pages/analytics.html` | Modify | Same login form changes as admin.html |
| `pages/analytics.js` | Modify | Cookie-based auth detection, sign-out button |
| `pages/dashboard.html` | Modify | Update sign-in card copy |
| `pages/index.html` | Modify | Update footer link + error copy |
| `pages/index.js` | Modify | Update `already_registered` error copy |
| `pages/recover.html` | Modify | Replace with redirect to `/dashboard.html` |
| `pages/recover.js` | Delete | No longer needed |
| `scripts/test.sh` | Modify | Add auth helpers test file |

---

### Task 1: Database Migration — `admin_users` Table

**Files:**
- Create: `db/migrations/009_admin_users.sql`
- Modify: `db/schema.sql` (add `admin_users` table definition)

- [ ] **Step 1: Write migration file**

Create `db/migrations/009_admin_users.sql`:

```sql
-- Admin users for magic-link authentication.
-- Bearer token (ADMIN_TOKEN) stays for machine-to-machine auth.
CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL DEFAULT 'migration'
);

INSERT OR IGNORE INTO admin_users (email) VALUES ('ericrihm@gmail.com');
```

- [ ] **Step 2: Update schema.sql**

Add the `admin_users` table definition to `db/schema.sql` after the last table definition, matching the migration exactly (minus the INSERT).

- [ ] **Step 3: Commit**

```bash
git add db/migrations/009_admin_users.sql db/schema.sql
git commit -m "feat(auth): migration 009 — admin_users table"
```

---

### Task 2: Auth Helpers Module — Token Signing and Cookie Parsing

**Files:**
- Create: `pages/functions/api/admin/auth/_auth_helpers.js`
- Create: `pages/functions/api/admin/auth/_auth_helpers.test.mjs`
- Modify: `scripts/test.sh`

- [ ] **Step 1: Write the failing tests**

Create `pages/functions/api/admin/auth/_auth_helpers.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Polyfill crypto.subtle for Node test environment
import { webcrypto } from "node:crypto";
if (!globalThis.crypto?.subtle) {
    globalThis.crypto = webcrypto;
}

const {
    signPayload,
    verifyPayload,
    buildMagicLinkToken,
    parseMagicLinkToken,
    buildSessionCookie,
    parseSessionCookie,
    base64url,
    debase64url,
} = await import("./_auth_helpers.js");

const TEST_SECRET = "a".repeat(64);

describe("base64url", () => {
    it("round-trips arbitrary strings", () => {
        const input = "hello@example.com.1234567890.abcdef";
        assert.equal(debase64url(base64url(input)), input);
    });

    it("produces URL-safe characters (no +, /, =)", () => {
        const encoded = base64url("test+value/with=padding");
        assert.ok(!/[+/=]/.test(encoded));
    });
});

describe("signPayload / verifyPayload", () => {
    it("verifies a valid signature", async () => {
        const payload = "test@example.com.9999999999999";
        const signed = await signPayload(payload, TEST_SECRET);
        assert.ok(signed.includes("."));
        const result = await verifyPayload(signed, TEST_SECRET);
        assert.equal(result, payload);
    });

    it("rejects a tampered payload", async () => {
        const signed = await signPayload("original", TEST_SECRET);
        const parts = signed.split(".");
        parts[0] = base64url("tampered");
        const tampered = parts.join(".");
        const result = await verifyPayload(tampered, TEST_SECRET);
        assert.equal(result, null);
    });

    it("rejects with wrong secret", async () => {
        const signed = await signPayload("payload", TEST_SECRET);
        const result = await verifyPayload(signed, "b".repeat(64));
        assert.equal(result, null);
    });
});

describe("buildMagicLinkToken / parseMagicLinkToken", () => {
    it("round-trips email + nonce with valid expiry", async () => {
        const expires = Date.now() + 15 * 60 * 1000;
        const nonce = "abc123def456";
        const token = await buildMagicLinkToken("admin@test.com", expires, nonce, TEST_SECRET);
        const result = await parseMagicLinkToken(token, TEST_SECRET);
        assert.equal(result.email, "admin@test.com");
        assert.equal(result.nonce, nonce);
        assert.equal(result.expires, expires);
    });

    it("returns null for expired token", async () => {
        const expires = Date.now() - 1000;
        const token = await buildMagicLinkToken("admin@test.com", expires, "nonce1", TEST_SECRET);
        const result = await parseMagicLinkToken(token, TEST_SECRET);
        assert.equal(result, null);
    });

    it("returns null for tampered token", async () => {
        const token = await buildMagicLinkToken("admin@test.com", Date.now() + 60000, "n", TEST_SECRET);
        const result = await parseMagicLinkToken(token + "x", TEST_SECRET);
        assert.equal(result, null);
    });
});

describe("buildSessionCookie / parseSessionCookie", () => {
    it("round-trips email with valid expiry", async () => {
        const expires = Date.now() + 24 * 60 * 60 * 1000;
        const cookie = await buildSessionCookie("admin@test.com", expires, TEST_SECRET);
        const result = await parseSessionCookie(cookie, TEST_SECRET);
        assert.equal(result.email, "admin@test.com");
        assert.equal(result.expires, expires);
    });

    it("returns null for expired cookie", async () => {
        const expires = Date.now() - 1;
        const cookie = await buildSessionCookie("admin@test.com", expires, TEST_SECRET);
        const result = await parseSessionCookie(cookie, TEST_SECRET);
        assert.equal(result, null);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pages/functions/api/admin/auth/_auth_helpers.test.mjs`
Expected: FAIL — module `_auth_helpers.js` not found.

- [ ] **Step 3: Implement the helpers module**

Create `pages/functions/api/admin/auth/_auth_helpers.js`:

```js
const enc = new TextEncoder();
const dec = new TextDecoder();

export function base64url(str) {
    const bytes = enc.encode(str);
    const binStr = String.fromCharCode(...bytes);
    return btoa(binStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function debase64url(b64) {
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    const binStr = atob(padded);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    return dec.decode(bytes);
}

async function hmacSign(payload, secret) {
    const key = await crypto.subtle.importKey(
        "raw", enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
    return base64url(String.fromCharCode(...sig));
}

async function hmacVerify(payload, signature, secret) {
    const expected = await hmacSign(payload, secret);
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
}

export async function signPayload(payload, secret) {
    const b64 = base64url(payload);
    const sig = await hmacSign(b64, secret);
    return b64 + "." + sig;
}

export async function verifyPayload(signed, secret) {
    const dot = signed.lastIndexOf(".");
    if (dot < 1) return null;
    const b64 = signed.slice(0, dot);
    const sig = signed.slice(dot + 1);
    if (!(await hmacVerify(b64, sig, secret))) return null;
    try { return debase64url(b64); } catch { return null; }
}

export async function buildMagicLinkToken(email, expires, nonce, secret) {
    const payload = email + "." + expires + "." + nonce;
    return signPayload(payload, secret);
}

export async function parseMagicLinkToken(token, secret) {
    const raw = await verifyPayload(token, secret);
    if (!raw) return null;
    const parts = raw.split(".");
    if (parts.length < 3) return null;
    const nonce = parts.pop();
    const expires = parseInt(parts.pop(), 10);
    const email = parts.join(".");
    if (!Number.isFinite(expires) || expires < Date.now()) return null;
    return { email, expires, nonce };
}

export async function buildSessionCookie(email, expires, secret) {
    const payload = email + "." + expires;
    return signPayload(payload, secret);
}

export async function parseSessionCookie(cookie, secret) {
    const raw = await verifyPayload(cookie, secret);
    if (!raw) return null;
    const dot = raw.lastIndexOf(".");
    if (dot < 1) return null;
    const email = raw.slice(0, dot);
    const expires = parseInt(raw.slice(dot + 1), 10);
    if (!Number.isFinite(expires) || expires < Date.now()) return null;
    return { email, expires };
}

export function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    for (const pair of cookieHeader.split(";")) {
        const eq = pair.indexOf("=");
        if (eq < 1) continue;
        cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    return cookies;
}

export const COOKIE_NAME = "__Host-sc-admin";
export const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
export const MAGIC_LINK_MAX_AGE = 15 * 60 * 1000;

export function sessionCookieHeader(value, maxAge = 86400) {
    return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test pages/functions/api/admin/auth/_auth_helpers.test.mjs`
Expected: All 9 tests pass.

- [ ] **Step 5: Wire test into test.sh**

Add to `scripts/test.sh` before the trailing newline:

```
    pages/functions/api/admin/auth/_auth_helpers.test.mjs \
```

- [ ] **Step 6: Run full test suite**

Run: `bash scripts/test.sh`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add pages/functions/api/admin/auth/_auth_helpers.js \
       pages/functions/api/admin/auth/_auth_helpers.test.mjs \
       scripts/test.sh
git commit -m "feat(auth): admin magic-link signing and cookie helpers with tests"
```

---

### Task 3: Admin Login Endpoint — `POST /api/admin/auth/login`

**Files:**
- Create: `pages/functions/api/admin/auth/login.js`

- [ ] **Step 1: Implement the login endpoint**

Create `pages/functions/api/admin/auth/login.js`:

```js
import {
    json, now, ulid, isValidEmail, verifyTurnstile, clientIp, ipHash,
    rateLimit, escapeHtml, emailShell, queueEmail,
} from "../../../_lib.js";
import { buildMagicLinkToken, MAGIC_LINK_MAX_AGE } from "./_auth_helpers.js";

const MAX_PER_HOUR = 5;
const CONSTANT_RESPONSE = {
    ok: true,
    message: "If that email is an admin account, we've sent a login link.",
};

function loginEmailBodies({ callbackUrl }) {
    const subject = "SC-CPE Admin Login";
    const text =
        "Click to sign in to the SC-CPE admin panel.\n\n" +
        "  " + callbackUrl + "\n\n" +
        "This link expires in 15 minutes. If you did not request this, ignore this email.\n\n" +
        "— Simply Cyber\n";
    const bodyHtml =
        "<p>Click to sign in to the SC-CPE admin panel.</p>" +
        '<p><a href="' + callbackUrl + '"' +
        ' style="display:inline-block;background:#0b3d5c;color:#fff;' +
        'padding:10px 16px;border-radius:4px;text-decoration:none;">' +
        "Sign in to Admin</a></p>" +
        '<p style="word-break:break-all;font-family:Menlo,monospace;font-size:12px;color:#555;">' +
        callbackUrl + "</p>" +
        '<p style="color:#666;font-size:12px;">This link expires in 15 minutes. If you did not ' +
        "request this, ignore this email.</p>";
    return {
        subject,
        text,
        html: emailShell({
            title: "Admin Login",
            preheader: "Your admin login link (expires in 15 min)",
            bodyHtml,
        }),
    };
}

export async function onRequestPost({ request, env }) {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const email = (body.email || "").trim().toLowerCase();
    const turnstileToken = body.turnstile_token;

    if (!isValidEmail(email)) return json({ error: "invalid_email" }, 400);

    const captcha = await verifyTurnstile(env, turnstileToken, clientIp(request));
    if (!captcha.ok) return json({ error: "captcha_failed" }, 403);

    const ip = clientIp(request);
    const ipH = await ipHash(ip);
    const hourBucket = new Date().toISOString().slice(0, 13);
    const rateKey = "admin_login:" + ipH + ":" + hourBucket;
    const rl = await rateLimit(env, rateKey, MAX_PER_HOUR);
    if (!rl.ok) {
        if (rl.status === 429) return json(CONSTANT_RESPONSE, 200);
        return json(rl.body, rl.status);
    }

    const admin = await env.DB.prepare(
        "SELECT id, email FROM admin_users WHERE lower(email) = ?1"
    ).bind(email).first();

    if (!admin) return json(CONSTANT_RESPONSE, 200);

    if (!env.ADMIN_COOKIE_SECRET) {
        console.error("ADMIN_COOKIE_SECRET not set — cannot send magic link");
        return json(CONSTANT_RESPONSE, 200);
    }

    const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
        .map(b => b.toString(16).padStart(2, "0")).join("");
    const expires = Date.now() + MAGIC_LINK_MAX_AGE;

    await env.RATE_KV.put("admin_nonce:" + nonce, email, { expirationTtl: 900 });

    const token = await buildMagicLinkToken(email, expires, nonce, env.ADMIN_COOKIE_SECRET);
    const redirect = body.redirect || "/admin.html";
    const siteBase = new URL(request.url).origin;
    const callbackUrl = siteBase + "/api/admin/auth/callback?token=" +
        encodeURIComponent(token) + "&redirect=" + encodeURIComponent(redirect);

    const bodies = loginEmailBodies({ callbackUrl });
    await queueEmail(env, {
        userId: null,
        template: "admin_login",
        to: admin.email,
        subject: bodies.subject,
        html: bodies.html,
        text: bodies.text,
        idempotencyKey: "admin_login:" + admin.id + ":" + hourBucket,
    });

    return json(CONSTANT_RESPONSE, 200);
}
```

- [ ] **Step 2: Commit**

```bash
git add pages/functions/api/admin/auth/login.js
git commit -m "feat(auth): admin magic-link login endpoint"
```

---

### Task 4: Admin Callback Endpoint — `GET /api/admin/auth/callback`

**Files:**
- Create: `pages/functions/api/admin/auth/callback.js`

- [ ] **Step 1: Implement the callback endpoint**

Create `pages/functions/api/admin/auth/callback.js`:

```js
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
```

- [ ] **Step 2: Commit**

```bash
git add pages/functions/api/admin/auth/callback.js
git commit -m "feat(auth): admin magic-link callback endpoint"
```

---

### Task 5: Admin Logout Endpoint — `POST /api/admin/auth/logout`

**Files:**
- Create: `pages/functions/api/admin/auth/logout.js`

- [ ] **Step 1: Implement the logout endpoint**

Create `pages/functions/api/admin/auth/logout.js`:

```js
import { json } from "../../../_lib.js";
import { sessionCookieHeader } from "./_auth_helpers.js";

export async function onRequestPost() {
    return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Set-Cookie": sessionCookieHeader("deleted", 0),
        },
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add pages/functions/api/admin/auth/logout.js
git commit -m "feat(auth): admin logout endpoint (clear cookie)"
```

---

### Task 6: Update `isAdmin()` — Cookie Path + Bearer Fallback

**Files:**
- Modify: `pages/functions/_lib.js:301-321`

- [ ] **Step 1: Update `isAdmin()` in `_lib.js`**

Replace the existing `isAdmin` function (lines 301-321 of `pages/functions/_lib.js`) with:

```js
export async function isAdmin(env, request) {
    // Path 1: Bearer token (machine-to-machine — workers, CI, smoke tests)
    const expected = env.ADMIN_TOKEN;
    const h = request.headers.get("Authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m && expected) {
        const given = m[1];
        const enc = new TextEncoder();
        const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
        const key = await crypto.subtle.importKey(
            "raw", keyMaterial, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
        );
        const a = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(given)));
        const b = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(expected)));
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff === 0;
    }

    // Path 2: Session cookie (browser — magic-link login)
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
        "SELECT id FROM admin_users WHERE lower(email) = ?1"
    ).bind(session.email.toLowerCase()).first();
    return !!admin;
}
```

- [ ] **Step 2: Run full test suite**

Run: `bash scripts/test.sh`
Expected: All tests pass (existing tests mock `isAdmin` or test through bearer path which is unchanged).

- [ ] **Step 3: Commit**

```bash
git add pages/functions/_lib.js
git commit -m "feat(auth): isAdmin() supports cookie path with bearer fallback"
```

---

### Task 7: Admin Page UI — Email Login Form + Sign-Out

**Files:**
- Modify: `pages/admin.html`
- Modify: `pages/admin.js`

- [ ] **Step 1: Update `admin.html` login section**

Replace lines 16-21 of `pages/admin.html` (the `<div class="sub">` through `</div>` for login) with:

```html
  <div class="sub" id="sub"><a href="/analytics.html">Analytics &rarr;</a></div>

  <div id="login" class="login">
    <p style="margin:0 0 12px;color:var(--fg2,#666);">Enter your admin email and we'll send you a login link — no token needed.</p>
    <form id="login-form" style="display:flex;flex-direction:column;gap:8px;max-width:340px;">
      <input type="email" id="admin-email" placeholder="admin@example.com" required autocomplete="email" style="padding:8px;border:1px solid var(--border,#ccc);border-radius:4px;font-size:1rem;">
      <div class="cf-turnstile" data-sitekey="0x4AAAAAAC9lHHxbfTKNzdFN" data-theme="auto"></div>
      <button type="submit">Send login link</button>
    </form>
    <div id="login-err" class="err" hidden></div>
    <div id="login-ok" hidden>
      <p style="color:var(--ok-fg,#16a34a);font-weight:600;">Check your inbox!</p>
      <p class="muted">If that email is an admin account, we sent a login link. It expires in 15 minutes.</p>
    </div>
  </div>
```

Add the Turnstile script to the `<head>` section (after the `<meta name="theme-color">` line):

```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
```

Add a sign-out button in the `#app` div, right after `<button class="refresh" id="refresh">Refresh</button>`:

```html
    <button class="refresh" id="signout" style="margin-left:8px;background:transparent;border:1px solid var(--border,#ccc);color:var(--fg2,#999);">Sign out</button>
```

- [ ] **Step 2: Update `admin.js` — cookie-based auth + email login + sign-out**

Replace the login/init section at the bottom of `pages/admin.js`. Find the existing event listener that handles the token input (the `go` button click handler at the end of the file) and replace the entire init block. The new init block should be:

```js
// --- Init: cookie-based auth or email login ---
(async function init() {
    // Check if already authenticated via cookie
    try {
        var testR = await fetch("/api/admin/ops-stats", { credentials: "include" });
        if (testR.ok) {
            TOKEN = "__cookie__";
            $("#login").style.display = "none";
            $("#app").style.display = "";
            load();
            return;
        }
    } catch (e) {}

    // Check for error param (expired magic link)
    var params = new URLSearchParams(location.search);
    if (params.get("error") === "expired") {
        var le = $("#login-err");
        le.textContent = "Login link expired or already used. Request a new one.";
        le.hidden = false;
        history.replaceState(null, "", location.pathname);
    }

    // Email login form
    var form = $("#login-form");
    if (form) {
        form.addEventListener("submit", async function (e) {
            e.preventDefault();
            var emailInput = $("#admin-email");
            var errEl = $("#login-err");
            var okEl = $("#login-ok");
            errEl.hidden = true;
            var fd = new FormData(form);
            var turnstileToken = fd.get("cf-turnstile-response");
            if (!turnstileToken) {
                errEl.textContent = "Please complete the anti-bot challenge.";
                errEl.hidden = false;
                return;
            }
            var btn = form.querySelector("button[type=submit]");
            btn.disabled = true;
            btn.textContent = "Sending…";
            try {
                var r = await fetch("/api/admin/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        email: emailInput.value.trim(),
                        turnstile_token: turnstileToken,
                        redirect: location.pathname,
                    }),
                });
                var data = await r.json();
                if (!r.ok) {
                    errEl.textContent = data.error || "Login failed.";
                    errEl.hidden = false;
                    return;
                }
                form.hidden = true;
                okEl.hidden = false;
            } catch (x) {
                errEl.textContent = "Network error — check your connection.";
                errEl.hidden = false;
            } finally {
                btn.disabled = false;
                btn.textContent = "Send login link";
            }
        });
    }
})();
```

Update the `fetchJson` function (line 19-24) to use credentials (cookie) instead of only bearer token:

```js
async function fetchJson(path) {
    var opts = { credentials: "include" };
    if (TOKEN && TOKEN !== "__cookie__") {
        opts.headers = { "Authorization": "Bearer " + TOKEN };
    }
    var r = await fetch(path, opts);
    if (r.status === 401) throw new Error("unauthorized (wrong token?)");
    if (!r.ok) throw new Error(path + " → HTTP " + r.status);
    return r.json();
}
```

Add sign-out handler (after the auto-refresh setup, near the bottom):

```js
var signoutBtn = $("#signout");
if (signoutBtn) {
    signoutBtn.addEventListener("click", async function () {
        await fetch("/api/admin/auth/logout", { method: "POST", credentials: "include" });
        TOKEN = null;
        $("#app").style.display = "none";
        $("#login").style.display = "";
        location.reload();
    }, { once: true });
}
```

Remove the old `go` button click handler that reads from the password input.

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html pages/admin.js
git commit -m "feat(auth): admin page email login form with sign-out"
```

---

### Task 8: Analytics Page UI — Same Login Changes

**Files:**
- Modify: `pages/analytics.html`
- Modify: `pages/analytics.js`

- [ ] **Step 1: Update `analytics.html` login section**

Replace lines 22-25 of `pages/analytics.html` (the login div) with:

```html
  <div id="login" class="login">
    <p style="margin:0 0 12px;color:var(--fg2,#666);">Enter your admin email and we'll send you a login link — no token needed.</p>
    <form id="login-form" style="display:flex;flex-direction:column;gap:8px;max-width:340px;">
      <input type="email" id="admin-email" placeholder="admin@example.com" required autocomplete="email" style="padding:8px;border:1px solid var(--border,#ccc);border-radius:4px;font-size:1rem;">
      <div class="cf-turnstile" data-sitekey="0x4AAAAAAC9lHHxbfTKNzdFN" data-theme="auto"></div>
      <button type="submit">Send login link</button>
    </form>
    <div id="login-err" class="err" hidden></div>
    <div id="login-ok" hidden>
      <p style="color:var(--ok-fg,#16a34a);font-weight:600;">Check your inbox!</p>
      <p class="muted">If that email is an admin account, we sent a login link. It expires in 15 minutes.</p>
    </div>
  </div>
```

Add the Turnstile script to the `<head>` section (after `<meta name="theme-color">`):

```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
```

Add a sign-out button in the `#app` div, inside the range-bar (after line 33, the `<span>` with id `ts`):

```html
      <button class="refresh" id="signout" style="background:transparent;border:1px solid var(--border,#ccc);color:var(--fg2,#999);">Sign out</button>
```

- [ ] **Step 2: Update `analytics.js` — same pattern as admin.js**

Update the `fetchJson` function (line 35-39) to support cookies:

```js
async function fetchJson(path) {
    var opts = { credentials: "include" };
    if (TOKEN && TOKEN !== "__cookie__") {
        opts.headers = { Authorization: "Bearer " + TOKEN };
    }
    var r = await fetch(path, opts);
    if (r.status === 401) throw new Error("unauthorized");
    if (!r.ok) throw new Error(path + " HTTP " + r.status);
    return r.json();
}
```

Replace the old token-input init block at the bottom of `analytics.js` with the same cookie-based auth pattern from Task 7:
- Check cookie auth first (fetch `/api/admin/analytics/growth?range=7d` with `credentials: "include"`)
- If authenticated, set `TOKEN = "__cookie__"`, hide login, show app, call `loadAll("30d")`
- If not, show login form with email + Turnstile
- Handle `?error=expired` query param
- Handle form submit (POST to `/api/admin/auth/login` with redirect `/analytics.html`)
- Add sign-out handler (same pattern)
- Remove the old `go` button click handler

- [ ] **Step 3: Commit**

```bash
git add pages/analytics.html pages/analytics.js
git commit -m "feat(auth): analytics page email login form with sign-out"
```

---

### Task 9: Dashboard UX Polish — Sign-In Copy

**Files:**
- Modify: `pages/dashboard.html:18-38`
- Modify: `pages/dashboard.js`

- [ ] **Step 1: Update the sign-in card copy**

Replace the content of `<section id="login-card">` (lines 18-38 of `pages/dashboard.html`) with:

```html
    <section id="login-card" class="card" hidden>
        <h2 style="margin-top:0;">Welcome back</h2>
        <p>Enter your email and we'll send you a link — no password needed.</p>
        <form id="login-form">
            <label>
                Email
                <input name="email" type="email" required maxlength="254" autocomplete="email"
                       style="width:100%;padding:8px;margin:6px 0 12px;border:1px solid var(--border,#ccc);border-radius:4px;font-size:1rem;">
            </label>
            <div class="cf-turnstile" data-sitekey="0x4AAAAAAC9lHHxbfTKNzdFN" data-theme="auto"></div>
            <button type="submit" style="margin-top:8px;">Send me my dashboard link</button>
        </form>
        <div id="login-err" class="err" hidden></div>
        <div id="login-ok" hidden>
            <p style="color:var(--ok-fg,#16a34a);font-weight:600;">Check your inbox!</p>
            <p>We sent a link to <strong id="login-ok-email"></strong>. It should arrive within a minute or two.</p>
            <p class="muted">Check spam too if you don't see it.</p>
        </div>
        <p class="muted" style="margin-top:1rem;font-size:0.85rem;">
            Don't have an account? <a href="/">Register here</a>
        </p>
    </section>
```

- [ ] **Step 2: Update `dashboard.js` login form handler**

Find the existing login form handler in `pages/dashboard.js` (the `login-form` submit listener). After `document.getElementById("login-ok").hidden = false;`, add:

```js
var emailDisplay = document.getElementById("login-ok-email");
if (emailDisplay) emailDisplay.textContent = fd.get("email");
```

- [ ] **Step 3: Commit**

```bash
git add pages/dashboard.html pages/dashboard.js
git commit -m "fix(ux): dashboard sign-in card — friendly 'Welcome back' copy"
```

---

### Task 10: Index Page Copy Updates

**Files:**
- Modify: `pages/index.html:60-62`
- Modify: `pages/index.js:23`

- [ ] **Step 1: Update footer link in `index.html`**

Replace lines 60-62 of `pages/index.html`:

```html
    <p class="muted" style="margin-top:2rem;font-size:0.9rem;">
        Lost your dashboard link? <a href="/recover.html">Recover it here</a>.
    </p>
```

With:

```html
    <p class="muted" style="margin-top:2rem;font-size:0.9rem;">
        Already registered? <a href="/dashboard.html">Sign in to your dashboard</a>
    </p>
```

- [ ] **Step 2: Update `already_registered` error in `index.js`**

Replace the `already_registered` entry in the `ERROR_COPY` object (line 23 of `pages/index.js`):

From:
```js
    already_registered: "That email is already registered. Use the recovery link below to get your dashboard URL.",
```

To:
```js
    already_registered: "That email is already registered.",
```

Then update the error display logic in the submit handler. Replace the simple `err.textContent` display for the non-ok case (around line 57-60) with a version that handles the `already_registered` case specially by building DOM nodes with a link:

```js
        if (!r.ok) {
            if (data.error === "already_registered") {
                err.textContent = "";
                var span = document.createElement("span");
                span.textContent = "That email is already registered. ";
                var link = document.createElement("a");
                link.href = "/dashboard.html";
                link.textContent = "Sign in to your dashboard";
                link.style.color = "inherit";
                link.style.textDecoration = "underline";
                var rest = document.createTextNode(" to access your attendance and certificates.");
                err.appendChild(span);
                err.appendChild(link);
                err.appendChild(rest);
            } else {
                err.textContent = ERROR_COPY[data.error] || "Registration failed (" + (data.error || r.status) + ").";
            }
            err.hidden = false;
            return;
        }
```

- [ ] **Step 3: Commit**

```bash
git add pages/index.html pages/index.js
git commit -m "fix(ux): index page — replace 'recover' links with 'sign in' wording"
```

---

### Task 11: Remove recover.html — Redirect to Dashboard

**Files:**
- Modify: `pages/recover.html` (replace contents with redirect)
- Delete: `pages/recover.js`

- [ ] **Step 1: Replace `recover.html` with a redirect page**

Replace the entire contents of `pages/recover.html` with:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=/dashboard.html">
<title>Redirecting</title>
<link rel="canonical" href="/dashboard.html">
</head>
<body>
<p>Redirecting to <a href="/dashboard.html">your dashboard</a>.</p>
</body>
</html>
```

- [ ] **Step 2: Delete `recover.js`**

```bash
rm pages/recover.js
```

- [ ] **Step 3: Commit**

```bash
git add pages/recover.html
git rm pages/recover.js
git commit -m "fix(ux): replace recover.html with redirect to dashboard"
```

---

### Task 12: Integration Smoke Test

**Files:** (no new files — manual verification)

- [ ] **Step 1: Run the full test suite**

Run: `bash scripts/test.sh`
Expected: All tests pass, including the new `_auth_helpers.test.mjs`.

- [ ] **Step 2: Verify the migration SQL is valid**

Run: `sqlite3 :memory: ".read db/migrations/009_admin_users.sql" && echo OK`
Expected: `OK` — no syntax errors.

- [ ] **Step 3: Check all admin auth helpers import correctly**

Run: `node -e "import('./pages/functions/api/admin/auth/_auth_helpers.js').then(() => console.log('OK'))"`
Expected: `OK`

- [ ] **Step 4: Verify recover.html redirects**

Open `pages/recover.html` and confirm it contains a `<meta http-equiv="refresh" content="0;url=/dashboard.html">` tag.

- [ ] **Step 5: Verify no dangling references to old recover flow remain**

Run: `grep -r "recover.html" pages/ --include="*.html" --include="*.js" -l`
Expected: Only `pages/recover.html` itself should match.

Run: `grep -r "Recover it here" pages/ --include="*.html" --include="*.js"`
Expected: No matches.

Run: `grep -r "recovery link" pages/ --include="*.html" --include="*.js"`
Expected: No matches (the API endpoint's constant response says "recovery link" but that's in `pages/functions/api/recover.js` which is server-side only — OK to keep for now).

- [ ] **Step 6: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix(auth): integration fixes from smoke test"
```

---

## Task Dependencies

```
Task 1 (migration)     ─┐
Task 2 (helpers+tests) ─┤── can run in parallel
                         │
Task 3 (login endpoint) ─┤── depends on Task 2
Task 4 (callback)       ─┤── depends on Task 2
Task 5 (logout)         ─┤── depends on Task 2
                         │
Task 6 (isAdmin update) ─┤── depends on Task 2
                         │
Task 7 (admin.html UI)  ─┤── depends on Task 6
Task 8 (analytics UI)   ─┤── depends on Task 6, can run parallel with Task 7
                         │
Task 9 (dashboard UX)   ─┤── independent (no admin auth dependency)
Task 10 (index copy)    ─┤── independent, can run parallel with Task 9
Task 11 (recover redirect)─┤── depends on Tasks 9 + 10
                         │
Task 12 (smoke test)    ─┘── depends on all above
```
