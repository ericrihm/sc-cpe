# Credential Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OBv3 credential export, LinkedIn one-click profile addition, CPE submission guides, and HSTS preload to SC-CPE.

**Architecture:** New API endpoints derive OBv3 JSON-LD from existing cert rows and sign with Ed25519. Dashboard gets LinkedIn deep-link + Open Badge download buttons. A new static page guides users through per-body CPE submission with pre-filled fields. No schema changes.

**Tech Stack:** Cloudflare Pages Functions (V8 isolates, Web Crypto Ed25519), vanilla JS, existing D1 schema.

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `pages/functions/api/ob/sign.js` | Ed25519 signing helpers: JCS canonicalization, base58btc multibase encoding, credential signing |
| Create | `pages/functions/api/ob/credential/[token].js` | OBv3 credential endpoint — cert lookup, JSON-LD construction, signing, audit logging |
| Create | `pages/functions/api/ob/jwks.js` | JWKS endpoint — Ed25519 public key in JWK format |
| Create | `pages/functions/api/ob/credential.test.mjs` | Tests for signing helpers and credential building |
| Create | `pages/cpe-guide.html` | CPE submission guide page (CompTIA / ISC2 / ISACA tabs) |
| Create | `pages/cpe-guide.js` | Tab switching + copy-to-clipboard logic |
| Create | `pages/cpe-guide.css` | Guide page styles |
| Modify | `pages/dashboard.js:355-412` | Add LinkedIn + Open Badge buttons to cert cards |
| Modify | `pages/dashboard.css:56-71` | Styles for new cert action buttons |
| Modify | `pages/functions/_middleware.js:77` | HSTS preload directive |
| Modify | `docs/RUNBOOK.md` | Ed25519 key generation + rotation procedure |
| Modify | `scripts/test.sh` | Wire new test file |

---

### Task 1: Ed25519 Signing Helpers

**Files:**
- Create: `pages/functions/api/ob/sign.js`
- Create: `pages/functions/api/ob/credential.test.mjs`
- Modify: `scripts/test.sh`

- [ ] **Step 1: Write the test file with signing helper tests**

Create `pages/functions/api/ob/credential.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { jcsCanonicalise, base58btcEncode, base58btcDecode, multibaseEncode } from "./sign.js";

test("jcsCanonicalise: sorts keys deterministically", () => {
    const obj = { z: 1, a: 2, m: { b: 3, a: 4 } };
    const result = jcsCanonicalise(obj);
    assert.equal(result, '{"a":2,"m":{"a":4,"b":3},"z":1}');
});

test("jcsCanonicalise: handles arrays (order preserved)", () => {
    const obj = { items: [3, 1, 2], name: "test" };
    const result = jcsCanonicalise(obj);
    assert.equal(result, '{"items":[3,1,2],"name":"test"}');
});

test("jcsCanonicalise: handles null and boolean", () => {
    const result = jcsCanonicalise({ a: null, b: true, c: false });
    assert.equal(result, '{"a":null,"b":true,"c":false}');
});

test("jcsCanonicalise: excludes undefined values", () => {
    const result = jcsCanonicalise({ a: 1, b: undefined, c: 3 });
    assert.equal(result, '{"a":1,"c":3}');
});

test("base58btcEncode + base58btcDecode roundtrip", () => {
    const input = new Uint8Array([1, 2, 3, 255, 0, 128]);
    const encoded = base58btcEncode(input);
    const decoded = base58btcDecode(encoded);
    assert.deepEqual(decoded, input);
});

test("base58btcEncode: known vector", () => {
    const input = new TextEncoder().encode("Hello");
    const encoded = base58btcEncode(input);
    assert.equal(encoded, "9Ajdvzr");
});

test("base58btcEncode: leading zeros preserved", () => {
    const input = new Uint8Array([0, 0, 1]);
    const encoded = base58btcEncode(input);
    assert.ok(encoded.startsWith("11"), "leading zeros become '1' chars");
});

test("multibaseEncode: prepends 'z' prefix", () => {
    const input = new Uint8Array([1, 2, 3]);
    const result = multibaseEncode(input);
    assert.ok(result.startsWith("z"));
    assert.equal(result, "z" + base58btcEncode(input));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test pages/functions/api/ob/credential.test.mjs`
Expected: FAIL with `Cannot find module './sign.js'`

- [ ] **Step 3: Write the signing helpers module**

Create `pages/functions/api/ob/sign.js`:

```js
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function jcsCanonicalise(obj) {
    if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
    if (Array.isArray(obj)) return "[" + obj.map(v => jcsCanonicalise(v)).join(",") + "]";
    const keys = Object.keys(obj).sort();
    const parts = [];
    for (const k of keys) {
        if (obj[k] === undefined) continue;
        parts.push(JSON.stringify(k) + ":" + jcsCanonicalise(obj[k]));
    }
    return "{" + parts.join(",") + "}";
}

export function base58btcEncode(bytes) {
    let num = 0n;
    for (const b of bytes) num = num * 256n + BigInt(b);
    let encoded = "";
    while (num > 0n) {
        encoded = B58_ALPHABET[Number(num % 58n)] + encoded;
        num = num / 58n;
    }
    for (const b of bytes) { if (b !== 0) break; encoded = "1" + encoded; }
    return encoded || "1";
}

export function base58btcDecode(str) {
    let num = 0n;
    for (const c of str) {
        const idx = B58_ALPHABET.indexOf(c);
        if (idx < 0) throw new Error("invalid base58 char: " + c);
        num = num * 58n + BigInt(idx);
    }
    const hex = num === 0n ? "" : num.toString(16);
    const padded = hex.length % 2 ? "0" + hex : hex;
    const dataBytes = [];
    for (let i = 0; i < padded.length; i += 2) dataBytes.push(parseInt(padded.slice(i, i + 2), 16));
    let leadingZeros = 0;
    for (const c of str) { if (c !== "1") break; leadingZeros++; }
    const result = new Uint8Array(leadingZeros + dataBytes.length);
    result.set(dataBytes, leadingZeros);
    return result;
}

export function multibaseEncode(bytes) {
    return "z" + base58btcEncode(bytes);
}

export async function signCredential(credential, privateKeyB64) {
    const keyBytes = Uint8Array.from(atob(privateKeyB64), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
        "raw", keyBytes, { name: "Ed25519" }, false, ["sign"],
    );
    const canonical = jcsCanonicalise(credential);
    const signature = new Uint8Array(
        await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(canonical)),
    );
    return multibaseEncode(signature);
}

export async function derivePublicJwk(privateKeyB64) {
    const keyBytes = Uint8Array.from(atob(privateKeyB64), c => c.charCodeAt(0));
    const keyPair = await crypto.subtle.importKey(
        "raw", keyBytes, { name: "Ed25519" }, true, ["sign"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", keyPair);
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test pages/functions/api/ob/credential.test.mjs`
Expected: 8 tests PASS

- [ ] **Step 5: Wire test into test.sh**

Add to `scripts/test.sh`, after the last test file in the `node --test` list:

```
    pages/functions/api/ob/credential.test.mjs \
```

The line goes before the backslash of `scripts/test_audit_pii_scrub.mjs`.

- [ ] **Step 6: Run full test suite**

Run: `bash scripts/test.sh`
Expected: 259+ tests pass (251 existing + 8 new), 0 failures

- [ ] **Step 7: Commit**

```bash
git add pages/functions/api/ob/sign.js pages/functions/api/ob/credential.test.mjs scripts/test.sh
git commit -m "feat(ob): Ed25519 signing helpers — JCS, base58btc, multibase"
```

---

### Task 2: OBv3 Credential Endpoint

**Files:**
- Create: `pages/functions/api/ob/credential/[token].js`
- Modify: `pages/functions/api/ob/credential.test.mjs`

- [ ] **Step 1: Add credential-building tests**

Append to `pages/functions/api/ob/credential.test.mjs`:

```js
import { buildObCredential } from "./credential/[token].js";

test("buildObCredential: produces valid OBv3 structure", () => {
    const cert = {
        id: "cert-123",
        public_token: "abc".repeat(22),
        period_yyyymm: "202604",
        period_start: "2026-04-01",
        period_end: "2026-04-30",
        cpe_total: 10.0,
        sessions_count: 20,
        generated_at: "2026-04-30T12:00:00Z",
        recipient_name_snapshot: "Jane Doe",
    };
    const origin = "https://sc-cpe-web.pages.dev";
    const result = buildObCredential(cert, origin);
    assert.deepEqual(result["@context"], [
        "https://www.w3.org/ns/credentials/v2",
        "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json",
    ]);
    assert.deepEqual(result.type, ["VerifiableCredential", "OpenBadgeCredential"]);
    assert.equal(result.issuer.name, "Simply Cyber");
    assert.equal(result.validFrom, "2026-04-30T12:00:00Z");
    assert.ok(result.name.includes("April 2026"));
    assert.ok(result.credentialSubject.achievement.criteria.narrative.includes("20"));
});

test("buildObCredential: formats period_yyyymm as readable month", () => {
    const cert = {
        id: "c1", public_token: "t".repeat(64), period_yyyymm: "202601",
        period_start: "2026-01-01", period_end: "2026-01-31",
        cpe_total: 5, sessions_count: 10, generated_at: "2026-01-31T00:00:00Z",
        recipient_name_snapshot: "X",
    };
    const result = buildObCredential(cert, "https://example.com");
    assert.ok(result.name.includes("January 2026"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test pages/functions/api/ob/credential.test.mjs`
Expected: FAIL with `Cannot find module './credential/[token].js'`

- [ ] **Step 3: Write the credential endpoint**

Create `pages/functions/api/ob/credential/[token].js`:

```js
import { json, audit, clientIp, ipHash, rateLimit } from "../../../_lib.js";
import { signCredential } from "../sign.js";

const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

function formatPeriod(yyyymm) {
    const y = yyyymm.slice(0, 4);
    const m = parseInt(yyyymm.slice(4), 10);
    return MONTHS[m - 1] + " " + y;
}

export function buildObCredential(cert, origin) {
    const period = formatPeriod(cert.period_yyyymm);
    return {
        "@context": [
            "https://www.w3.org/ns/credentials/v2",
            "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json",
        ],
        id: origin + "/api/ob/credential/" + cert.public_token + ".json",
        type: ["VerifiableCredential", "OpenBadgeCredential"],
        issuer: {
            id: origin,
            type: ["Profile"],
            name: "Simply Cyber",
            url: "https://www.youtube.com/@SimplyCyber",
        },
        validFrom: cert.generated_at,
        name: "Simply Cyber CPE Certificate — " + period,
        credentialSubject: {
            type: ["AchievementSubject"],
            achievement: {
                id: origin + "/achievements/cpe-attendance",
                type: ["Achievement"],
                name: "CPE/CEU Attendance Credit",
                description: "Continuing professional education credit earned by attending the Simply Cyber Daily Threat Briefing livestream.",
                criteria: {
                    narrative: "Attended " + cert.sessions_count + " Daily Threat Briefing sessions during " + period + ", verified via YouTube live chat code matching.",
                },
            },
        },
    };
}

export async function onRequestGet({ params, env, request }) {
    const raw = params.token;
    const token = raw?.endsWith(".json") ? raw.slice(0, -5) : raw;
    if (!token || token.length < 32 || token.length > 128) {
        return json({ error: "invalid_token" }, 400);
    }

    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, "ob_credential:" + ipH, 120);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    const row = await env.DB.prepare(`
        SELECT id, public_token, period_yyyymm, period_start, period_end,
               cpe_total, sessions_count, generated_at, recipient_name_snapshot,
               state
        FROM certs WHERE public_token = ?1
    `).bind(token).first();

    if (!row || row.state === "revoked" || row.state === "regenerated" || row.state === "pending") {
        return new Response(JSON.stringify({ error: "not_found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
    }

    if (!env.OB_SIGNING_KEY) {
        return json({ error: "signing_not_configured" }, 503);
    }

    const origin = new URL(request.url).origin;
    const credential = buildObCredential(row, origin);

    const proofValue = await signCredential(credential, env.OB_SIGNING_KEY);

    credential.proof = {
        type: "DataIntegrityProof",
        cryptosuite: "eddsa-rdfc-2022",
        verificationMethod: origin + "/api/ob/jwks#ob-signing-key",
        proofPurpose: "assertionMethod",
        created: row.generated_at,
        proofValue: proofValue,
    };

    await audit(env, "api", null, "credential_exported", "cert", row.id, null, null, {
        ip_hash: ipH,
    });

    return new Response(JSON.stringify(credential, null, 2), {
        status: 200,
        headers: {
            "Content-Type": "application/ld+json",
            "Cache-Control": "no-store",
        },
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test pages/functions/api/ob/credential.test.mjs`
Expected: 10 tests PASS (8 from Task 1 + 2 new)

- [ ] **Step 5: Commit**

```bash
git add pages/functions/api/ob/credential/[token].js pages/functions/api/ob/credential.test.mjs
git commit -m "feat(ob): OBv3 credential endpoint with Ed25519 signed proof"
```

---

### Task 3: JWKS Endpoint

**Files:**
- Create: `pages/functions/api/ob/jwks.js`
- Modify: `pages/functions/api/ob/credential.test.mjs`

- [ ] **Step 1: Add JWKS derivation test**

Append to `pages/functions/api/ob/credential.test.mjs`:

```js
import { derivePublicJwk } from "./sign.js";

test("derivePublicJwk: returns OKP/Ed25519 JWK", async () => {
    const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.privateKey));
    const b64 = btoa(String.fromCharCode(...raw));
    const jwk = await derivePublicJwk(b64);
    assert.equal(jwk.kty, "OKP");
    assert.equal(jwk.crv, "Ed25519");
    assert.ok(jwk.x, "x component present");
    assert.equal(jwk.d, undefined, "private key not leaked");
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test pages/functions/api/ob/credential.test.mjs`
Expected: 11 tests PASS

- [ ] **Step 3: Write the JWKS endpoint**

Create `pages/functions/api/ob/jwks.js`:

```js
import { derivePublicJwk } from "./sign.js";

export async function onRequestGet({ env }) {
    if (!env.OB_SIGNING_KEY) {
        return new Response(JSON.stringify({ error: "signing_not_configured" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
        });
    }

    const pub = await derivePublicJwk(env.OB_SIGNING_KEY);

    return new Response(JSON.stringify({
        keys: [{
            ...pub,
            kid: "ob-signing-key",
            use: "sig",
            alg: "EdDSA",
        }],
    }, null, 2), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
        },
    });
}
```

- [ ] **Step 4: Commit**

```bash
git add pages/functions/api/ob/jwks.js pages/functions/api/ob/credential.test.mjs
git commit -m "feat(ob): JWKS endpoint for Ed25519 public key discovery"
```

---

### Task 4: LinkedIn Deep-Link + Open Badge Buttons on Dashboard

**Files:**
- Modify: `pages/dashboard.js:355-412`
- Modify: `pages/dashboard.css:56-71`

- [ ] **Step 1: Add CSS for new cert action buttons**

In `pages/dashboard.css`, after the `.cert-verify:hover` rule (line 71), add:

```css
.cert-action-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 40px; height: 40px; min-height: 44px;
    border: 1px solid var(--border); border-radius: 4px;
    background: var(--card); color: var(--muted);
    text-decoration: none; cursor: pointer;
    touch-action: manipulation; font-size: 18px;
}
.cert-action-icon:hover { background: var(--accent-soft-bg); color: var(--accent); border-color: var(--accent); }
.cert-action-icon[title]:hover::after { content: attr(title); }
```

- [ ] **Step 2: Modify the certCard function in dashboard.js to add LinkedIn + OB buttons**

In `pages/dashboard.js`, find the `certCard` function (line 355). Replace the `cert-actions` div HTML (inside `row.innerHTML`, the section starting with `'<div class="cert-actions">'`) with the following. The existing `cert-verify` link and `fb-details` feedback section remain; we add two icon links before them.

Find in `pages/dashboard.js` (inside `row.innerHTML` assignment, the cert-actions div):
```js
        '<div class="cert-actions">' +
        '<a class="cert-verify" href="/verify.html?t=' + encodeURIComponent(c.public_token) + '" target="_blank" rel="noopener">Open certificate ↗</a>' +
```

Replace with:
```js
        '<div class="cert-actions">' +
        linkedInButton(c) +
        obBadgeButton(c) +
        cpeGuideButton(c) +
        '<a class="cert-verify" href="/verify.html?t=' + encodeURIComponent(c.public_token) + '" target="_blank" rel="noopener">Open certificate ↗</a>' +
```

- [ ] **Step 3: Add the three button builder functions**

Add these functions before the `certCard` function in `pages/dashboard.js` (before line 355):

```js
function linkedInButton(c) {
    if (c.state === "pending") return "";
    var period = formatPeriod(c.period_yyyymm);
    var d = new Date(c.generated_at || Date.now());
    var params = new URLSearchParams({
        startTask: "CERTIFICATION_NAME",
        name: "Simply Cyber CPE Certificate — " + period,
        issueYear: String(d.getFullYear()),
        issueMonth: String(d.getMonth() + 1),
        certId: c.public_token,
        certUrl: location.origin + "/verify.html?t=" + encodeURIComponent(c.public_token),
    });
    return '<a class="cert-action-icon" href="https://www.linkedin.com/profile/add?' +
        escapeHtml(params.toString()) + '" target="_blank" rel="noopener" ' +
        'title="Add to LinkedIn">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">' +
        '<path d="M19 3a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h14m-.5 15.5v-5.3a3.26 3.26 0 00-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 011.4 1.4v4.93h2.79M6.88 8.56a1.68 1.68 0 001.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 00-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"/>' +
        '</svg></a>';
}

function obBadgeButton(c) {
    if (c.state === "pending") return "";
    return '<a class="cert-action-icon" href="/api/ob/credential/' +
        encodeURIComponent(c.public_token) + '.json" target="_blank" rel="noopener" ' +
        'title="Open Badge (JSON-LD)">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<circle cx="12" cy="8" r="5"/><path d="M8 13l-1 8 5-3 5 3-1-8"/>' +
        '</svg></a>';
}

function cpeGuideButton(c) {
    if (c.state === "pending") return "";
    var period = formatPeriod(c.period_yyyymm);
    var params = new URLSearchParams({
        name: period,
        hours: String(Number(c.cpe_total).toFixed(1)),
        sessions: String(c.sessions_count),
        certUrl: location.origin + "/verify.html?t=" + encodeURIComponent(c.public_token),
        downloadUrl: location.origin + "/api/download/" + encodeURIComponent(c.public_token),
    });
    return '<a class="cert-action-icon" href="/cpe-guide.html?' +
        escapeHtml(params.toString()) + '" target="_blank" rel="noopener" ' +
        'title="CPE submission guide">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>' +
        '<polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>' +
        '<line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>' +
        '</svg></a>';
}
```

- [ ] **Step 4: Run full test suite to verify nothing broke**

Run: `bash scripts/test.sh`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add pages/dashboard.js pages/dashboard.css
git commit -m "feat(dashboard): LinkedIn, Open Badge, and CPE guide buttons on cert cards"
```

---

### Task 5: CPE Submission Guide Page

**Files:**
- Create: `pages/cpe-guide.html`
- Create: `pages/cpe-guide.js`
- Create: `pages/cpe-guide.css`

- [ ] **Step 1: Create the HTML page**

Create `pages/cpe-guide.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SC-CPE — CPE Submission Guide</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="theme-color" content="#0b3d5c">
<meta name="color-scheme" content="light dark">
<script src="/theme.js"></script>
<link rel="stylesheet" href="/cpe-guide.css">
</head>
<body>
<main class="narrow">
    <h1><a href="/">SC-CPE</a> — CPE Submission Guide</h1>
    <p class="guide-intro">Use the steps below to submit your CPE/CEU credits to your certification body. Fields are pre-filled from your certificate — just copy and paste.</p>

    <div class="guide-field-bar" id="field-bar" hidden>
        <div class="guide-field"><span class="guide-label">Period</span><span class="guide-val" id="f-name">—</span></div>
        <div class="guide-field"><span class="guide-label">CPE hours</span><span class="guide-val" id="f-hours">—</span></div>
        <div class="guide-field"><span class="guide-label">Sessions</span><span class="guide-val" id="f-sessions">—</span></div>
    </div>

    <div class="tabs" role="tablist">
        <button class="tab active" role="tab" aria-selected="true" data-tab="comptia">CompTIA</button>
        <button class="tab" role="tab" aria-selected="false" data-tab="isc2">ISC2</button>
        <button class="tab" role="tab" aria-selected="false" data-tab="isaca">ISACA</button>
    </div>

    <section class="tab-panel active" id="panel-comptia">
        <h2>Submit to CompTIA CE Portal</h2>
        <ol class="guide-steps">
            <li>Go to <a href="https://ce.comptia.org" target="_blank" rel="noopener">ce.comptia.org</a> and sign in</li>
            <li>Click <strong>Submit a CE Activity</strong></li>
            <li>Fill in the fields below (click to copy):</li>
        </ol>
        <table class="copy-table">
            <tr><td>Activity Title</td><td><button class="copy-btn" data-value="Simply Cyber Daily Threat Briefing">Simply Cyber Daily Threat Briefing</button></td></tr>
            <tr><td>Provider</td><td><button class="copy-btn" data-value="Simply Cyber LLC">Simply Cyber LLC</button></td></tr>
            <tr><td>CEU Amount</td><td><button class="copy-btn" id="ct-hours">—</button></td></tr>
            <tr><td>Date Range</td><td><button class="copy-btn" id="ct-dates">—</button></td></tr>
            <tr><td>Verification URL</td><td><button class="copy-btn" id="ct-verify">—</button></td></tr>
        </table>
        <ol class="guide-steps" start="4">
            <li>Upload your <strong>signed PDF certificate</strong> as evidence: <a id="ct-dl" href="#" class="guide-dl-btn">Download PDF</a></li>
            <li>Click <strong>Submit</strong></li>
        </ol>
    </section>

    <section class="tab-panel" id="panel-isc2">
        <h2>Submit to ISC2 CPE Portal</h2>
        <ol class="guide-steps">
            <li>Go to <a href="https://cpe.isc2.org" target="_blank" rel="noopener">cpe.isc2.org</a> and sign in</li>
            <li>Click <strong>Report CPE Credits</strong> → <strong>Education</strong></li>
            <li>Fill in the fields below (click to copy):</li>
        </ol>
        <table class="copy-table">
            <tr><td>Activity Name</td><td><button class="copy-btn" data-value="Simply Cyber Daily Threat Briefing — Live Cybersecurity Briefing">Simply Cyber Daily Threat Briefing — Live Cybersecurity Briefing</button></td></tr>
            <tr><td>CPE Credits (Group B)</td><td><button class="copy-btn" id="i2-hours">—</button></td></tr>
            <tr><td>Completion Date</td><td><button class="copy-btn" id="i2-dates">—</button></td></tr>
            <tr><td>Verification URL</td><td><button class="copy-btn" id="i2-verify">—</button></td></tr>
        </table>
        <ol class="guide-steps" start="4">
            <li>Upload your <strong>signed PDF certificate</strong>: <a id="i2-dl" href="#" class="guide-dl-btn">Download PDF</a></li>
            <li>Click <strong>Submit</strong></li>
        </ol>
    </section>

    <section class="tab-panel" id="panel-isaca">
        <h2>Submit to ISACA CPE Portal</h2>
        <ol class="guide-steps">
            <li>Go to <a href="https://www.isaca.org/credentialing/cpe" target="_blank" rel="noopener">isaca.org/credentialing/cpe</a> and sign in</li>
            <li>Click <strong>Report CPE Hours</strong></li>
            <li>Fill in the fields below (click to copy):</li>
        </ol>
        <table class="copy-table">
            <tr><td>Activity Title</td><td><button class="copy-btn" data-value="Simply Cyber Daily Threat Briefing">Simply Cyber Daily Threat Briefing</button></td></tr>
            <tr><td>Activity Type</td><td><button class="copy-btn" data-value="Attending professional/educational events or conferences">Attending professional/educational events or conferences</button></td></tr>
            <tr><td>Provider</td><td><button class="copy-btn" data-value="Simply Cyber LLC">Simply Cyber LLC</button></td></tr>
            <tr><td>CPE Hours</td><td><button class="copy-btn" id="ia-hours">—</button></td></tr>
            <tr><td>Completion Date</td><td><button class="copy-btn" id="ia-dates">—</button></td></tr>
            <tr><td>Description</td><td><button class="copy-btn" data-value="Live daily cybersecurity briefing covering current threats, vulnerabilities, risk management, security operations, incident response, and governance.">Live daily cybersecurity briefing covering current threats, vulnerabilities, and defensive strategies.</button></td></tr>
            <tr><td>Verification URL</td><td><button class="copy-btn" id="ia-verify">—</button></td></tr>
        </table>
        <ol class="guide-steps" start="4">
            <li>Upload your <strong>signed PDF certificate</strong>: <a id="ia-dl" href="#" class="guide-dl-btn">Download PDF</a></li>
            <li>Click <strong>Submit</strong></li>
        </ol>
    </section>

    <p class="guide-footer">Acceptance is ultimately the certification body's decision — see <a href="/terms.html#5">Terms §5</a>.</p>
</main>
<script src="/cpe-guide.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create the JavaScript**

Create `pages/cpe-guide.js`:

```js
(function () {
    var params = new URLSearchParams(location.search);
    var name = params.get("name") || "";
    var hours = params.get("hours") || "";
    var sessions = params.get("sessions") || "";
    var certUrl = params.get("certUrl") || "";
    var downloadUrl = params.get("downloadUrl") || "";

    if (name) {
        document.getElementById("field-bar").hidden = false;
        document.getElementById("f-name").textContent = name;
        document.getElementById("f-hours").textContent = hours + " CPE";
        document.getElementById("f-sessions").textContent = sessions + " sessions";
    }

    var hourEls = ["ct-hours", "i2-hours", "ia-hours"];
    for (var i = 0; i < hourEls.length; i++) {
        var el = document.getElementById(hourEls[i]);
        if (el && hours) { el.textContent = hours; el.dataset.value = hours; }
    }

    var dateEls = ["ct-dates", "i2-dates", "ia-dates"];
    for (var i = 0; i < dateEls.length; i++) {
        var el = document.getElementById(dateEls[i]);
        if (el && name) { el.textContent = name; el.dataset.value = name; }
    }

    var verifyEls = ["ct-verify", "i2-verify", "ia-verify"];
    for (var i = 0; i < verifyEls.length; i++) {
        var el = document.getElementById(verifyEls[i]);
        if (el && certUrl) { el.textContent = certUrl; el.dataset.value = certUrl; }
    }

    var dlEls = ["ct-dl", "i2-dl", "ia-dl"];
    for (var i = 0; i < dlEls.length; i++) {
        var el = document.getElementById(dlEls[i]);
        if (el && downloadUrl) el.href = downloadUrl;
    }

    document.addEventListener("click", function (e) {
        var btn = e.target.closest(".copy-btn");
        if (!btn) return;
        var val = btn.dataset.value || btn.textContent;
        if (!val || val === "—") return;
        navigator.clipboard.writeText(val).then(function () {
            var orig = btn.textContent;
            btn.textContent = "Copied!";
            btn.classList.add("copied");
            setTimeout(function () {
                btn.textContent = orig;
                btn.classList.remove("copied");
            }, 1500);
        });
    });

    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
        tabs[i].addEventListener("click", function () {
            var target = this.dataset.tab;
            for (var j = 0; j < tabs.length; j++) {
                tabs[j].classList.toggle("active", tabs[j] === this);
                tabs[j].setAttribute("aria-selected", tabs[j] === this ? "true" : "false");
            }
            var panels = document.querySelectorAll(".tab-panel");
            for (var j = 0; j < panels.length; j++) {
                panels[j].classList.toggle("active", panels[j].id === "panel-" + target);
            }
        });
    }
})();
```

- [ ] **Step 3: Create the CSS**

Create `pages/cpe-guide.css`:

```css
.guide-intro { color: var(--muted); margin-bottom: 20px; }
.guide-field-bar {
    display: flex; gap: 16px; flex-wrap: wrap;
    background: var(--card); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px 16px; margin-bottom: 20px;
}
.guide-field { display: flex; flex-direction: column; gap: 2px; }
.guide-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.guide-val { font-size: 15px; font-weight: 600; color: var(--fg-strong); }

.tabs {
    display: flex; gap: 0; border-bottom: 2px solid var(--border); margin-bottom: 20px;
}
.tab {
    padding: 10px 20px; background: none; border: none; border-bottom: 2px solid transparent;
    margin-bottom: -2px; cursor: pointer; font-size: 14px; font-weight: 600;
    color: var(--muted); transition: color 0.15s, border-color 0.15s;
}
.tab:hover { color: var(--fg); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }

.tab-panel { display: none; }
.tab-panel.active { display: block; }

.guide-steps { padding-left: 20px; }
.guide-steps li { margin-bottom: 10px; line-height: 1.6; }

.copy-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
.copy-table td { padding: 8px 12px; border: 1px solid var(--border); vertical-align: top; }
.copy-table td:first-child { font-weight: 600; width: 140px; white-space: nowrap; color: var(--fg-strong); }
.copy-btn {
    background: var(--card); border: 1px solid var(--border); border-radius: 4px;
    padding: 6px 10px; cursor: pointer; font-size: 13px; color: var(--fg);
    text-align: left; width: 100%; word-break: break-all;
    transition: background 0.15s, border-color 0.15s;
}
.copy-btn:hover { background: var(--accent-soft-bg); border-color: var(--accent); }
.copy-btn.copied { background: var(--ok-soft-bg); border-color: var(--ok-soft-border); color: var(--ok-soft-text); }

.guide-dl-btn {
    display: inline-block; padding: 8px 16px; background: var(--accent);
    color: var(--accent-fg); border-radius: 4px; text-decoration: none;
    font-weight: 600; font-size: 13px;
}
.guide-dl-btn:hover { opacity: 0.9; }

.guide-footer { margin-top: 24px; font-size: 12px; color: var(--muted); }

@media (max-width: 480px) {
    .copy-table td:first-child { width: auto; white-space: normal; }
    .guide-field-bar { flex-direction: column; gap: 8px; }
}
```

- [ ] **Step 4: Commit**

```bash
git add pages/cpe-guide.html pages/cpe-guide.js pages/cpe-guide.css
git commit -m "feat: CPE submission guide page with per-body instructions and copy buttons"
```

---

### Task 6: CSP Update for CPE Guide

**Files:**
- Modify: `pages/functions/_middleware.js:17-31`

- [ ] **Step 1: Verify no CSP changes needed**

The CPE guide page uses only `'self'` scripts and styles. No external resources. The existing CSP policy already allows `script-src 'self'` and `style-src 'self' 'unsafe-inline'`. No Turnstile on this page.

Confirm: No changes needed to the CSP. Move to the next task.

- [ ] **Step 2: Commit (skip — no changes)**

No commit needed for this task.

---

### Task 7: HSTS Preload Directive

**Files:**
- Modify: `pages/functions/_middleware.js:77`

- [ ] **Step 1: Update the HSTS header**

In `pages/functions/_middleware.js`, find line 77:

```js
    res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
```

Replace with:

```js
    res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
```

- [ ] **Step 2: Run full test suite**

Run: `bash scripts/test.sh`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add pages/functions/_middleware.js
git commit -m "fix(security): HSTS preload directive — max-age=2y, preload flag"
```

---

### Task 8: RUNBOOK Update — Ed25519 Key Setup

**Files:**
- Modify: `docs/RUNBOOK.md`

- [ ] **Step 1: Add Ed25519 key section to RUNBOOK**

At the end of `docs/RUNBOOK.md`, before the final blank line, add:

```markdown

## Open Badge Signing Key (Ed25519)

### Initial setup

Generate an Ed25519 keypair and store the private key as a Pages secret:

```sh
node -e "
(async () => {
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign','verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.privateKey));
  console.log(Buffer.from(raw).toString('base64'));
})();
"
```

Then store it:

```sh
cd pages && wrangler pages secret put OB_SIGNING_KEY
# paste the base64 string when prompted
```

### Verify

```sh
curl -s https://sc-cpe-web.pages.dev/api/ob/jwks | jq .
```

Should return a JWK with `"kty": "OKP"`, `"crv": "Ed25519"`, and a populated `x` field.

### Rotation

Same as initial setup. Generate a new key, update the secret, redeploy.
After rotation, credentials signed with the old key are no longer verifiable
via the JWKS endpoint. If backward verification matters, keep the old public
key in the JWKS response (multi-key support — add a second entry to the
`keys` array with a different `kid`).
```

- [ ] **Step 2: Commit**

```bash
git add docs/RUNBOOK.md
git commit -m "docs(runbook): Ed25519 key generation and rotation for Open Badge signing"
```

---

### Task 9: Integration Smoke Test

**Files:** None (manual verification)

- [ ] **Step 1: Run the full test suite one final time**

Run: `bash scripts/test.sh`
Expected: 259+ tests pass, 0 failures

- [ ] **Step 2: Verify file structure is correct**

Run: `ls -la pages/functions/api/ob/`
Expected: `sign.js`, `jwks.js`, `credential.test.mjs`, and `credential/[token].js`

Run: `ls -la pages/cpe-guide.*`
Expected: `cpe-guide.html`, `cpe-guide.js`, `cpe-guide.css`

- [ ] **Step 3: Verify no accidental test regressions**

Run: `bash scripts/test.sh 2>&1 | tail -5`
Expected: `pass` count >= 259, `fail 0`

- [ ] **Step 4: Final commit (if any unstaged changes)**

If any files were missed:
```bash
git status
# add anything relevant, commit
```

---

## Self-Review

**Spec coverage check:**
- ✅ Section 1 (OBv3 credential endpoint) → Task 2
- ✅ Section 2 (JWKS endpoint) → Task 3
- ✅ Section 3 (LinkedIn integration) → Task 4
- ✅ Section 4 (CPE submission guide) → Task 5
- ✅ Section 5 (HSTS preload) → Task 7
- ✅ Section 6 (Ed25519 key generation docs) → Task 8
- ✅ Rate limiting on credential endpoint → Task 2 (120 req/window)
- ✅ Audit logging (`credential_exported`) → Task 2
- ✅ Revoked/pending/regenerated certs return 404 → Task 2
- ✅ CSP compliance (no inline scripts) → Task 6 (verified no changes needed)

**Placeholder scan:** No TBD, TODO, or "add appropriate" language found.

**Type consistency:**
- `buildObCredential(cert, origin)` — defined in Task 2, imported in Task 2 tests
- `signCredential(credential, privateKeyB64)` — defined in Task 1, used in Task 2
- `derivePublicJwk(privateKeyB64)` — defined in Task 1, used in Task 3
- `jcsCanonicalise`, `base58btcEncode`, `base58btcDecode`, `multibaseEncode` — defined and tested in Task 1
- `formatPeriod(yyyymm)` — used in both Task 2 (server) and Task 4 (client); both define locally since they're in different runtimes (Workers vs browser)
- `linkedInButton(c)`, `obBadgeButton(c)`, `cpeGuideButton(c)` — defined and used in Task 4
