# Email Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elevate all SC-CPE user-facing emails from functional notifications to polished product communications — better copy, gold CTA buttons, progress bars, code blocks, and deliverability headers.

**Architecture:** Modify existing email construction code in-place. Add shared helper functions (`emailButton`, `emailCode`, `emailProgress`, `emailDivider`) to `_lib.js` and mirror in purge worker. Rewrite each email's subject, preheader, and body HTML to use the helpers. Add optional `headers` passthrough for List-Unsubscribe support.

**Tech Stack:** Cloudflare Pages Functions (JS), Cloudflare Workers (JS), Python (generate.py), Resend API

---

## File Map

| File | Role | Changes |
|------|------|---------|
| `pages/functions/_lib.js` | Shared helpers | Add 4 helper functions, update `emailShell` signature + footer, update `queueEmail` for headers |
| `pages/functions/api/register.js` | Registration email | Rewrite `welcomeEmailBodies()` |
| `pages/functions/api/recover.js` | Recovery email | Rewrite `recoveryEmailBodies()` |
| `pages/functions/api/me/[token]/resend-code.js` | Code resend email | Rewrite `bodies()` |
| `pages/functions/api/admin/cert/[token]/resend.js` | Cert resend email | Rewrite `buildBodies()` |
| `workers/purge/src/index.js` | Purge worker emails | Mirror helpers, update `emailShell`, rewrite cert nudge + renewal nudge bodies |
| `workers/email-sender/src/index.js` | Email sender | Add `headers` passthrough to Resend API call |
| `services/certs/generate.py` | Cert delivery email | Wrap in emailShell equivalent, rewrite body with card layout |
| `docs/RUNBOOK.md` | Ops procedures | Add DMARC setup instructions |

---

### Task 1: Add Email Helper Functions to `_lib.js`

**Files:**
- Modify: `pages/functions/_lib.js:267-314`

- [ ] **Step 1: Add `emailButton()` helper after line 266 (before `emailShell`)**

Insert before `emailShell`:

```javascript
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
```

- [ ] **Step 2: Update `emailShell()` signature and footer**

Change `emailShell` to accept optional `siteBase`:

```javascript
export function emailShell({ title, preheader = "", bodyHtml, siteBase = "https://sc-cpe-web.pages.dev" }) {
```

Update the footer div (currently at line 280-283):

```html
  <div style="padding:16px 24px;border-top:1px solid #e6eaee;font-size:11px;color:#777;">
    You're receiving this because you registered at
    <a href="${siteBase}" style="color:#777;">Simply Cyber CPE</a>.<br/>
    Questions? Reply to this email.
  </div>
```

- [ ] **Step 3: Update `queueEmail()` to support optional headers**

Change the function signature and payload serialization:

```javascript
export async function queueEmail(env, { userId, template, to, subject, html, text, idempotencyKey, headers }) {
    const payloadObj = { html_body: html, text_body: text };
    if (headers) payloadObj.headers = headers;
    const payload = JSON.stringify(payloadObj);
```

- [ ] **Step 4: Verify no tests break**

```bash
bash scripts/test.sh
```

Expected: All existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add pages/functions/_lib.js
git commit -m "feat(email): add helper functions (button, code, progress, divider) and headers support"
```

---

### Task 2: Mirror Helpers in Purge Worker

**Files:**
- Modify: `workers/purge/src/index.js:286-305`

The purge worker has its own copy of `emailShell` (CLAUDE.md invariant: must stay in sync). It also needs local copies of the helpers since it can't import from `_lib.js`.

- [ ] **Step 1: Add helper functions before `emailShell` in purge worker**

Insert before `function emailShell` (line 286):

```javascript
function emailButton(text, url) {
    return `<p style="text-align:center;margin:24px 0;">
  <a href="${url}" style="display:inline-block;background:#d4a73a;color:#0b3d5c;
     font-weight:bold;padding:12px 28px;border-radius:6px;text-decoration:none;
     font-size:14px;letter-spacing:0.02em;">${escapeHtml(text)}</a>
</p>`;
}

function emailCode(code) {
    return `<div style="text-align:center;margin:20px 0;">
  <div style="display:inline-block;background:#0b3d5c;color:#d4a73a;
       font-family:Menlo,Consolas,monospace;font-size:22px;font-weight:bold;
       padding:14px 28px;border-radius:8px;letter-spacing:0.06em;">
       ${escapeHtml(code)}</div>
</div>`;
}

function emailProgress(pct) {
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

function emailDivider() {
    return `<hr style="border:none;border-top:1px solid #e6eaee;margin:20px 0;">`;
}
```

Note: `function` not `export function` — purge worker uses module-local scope.

- [ ] **Step 2: Update purge worker `emailShell` to match `_lib.js`**

Update signature and footer to match Task 1 changes exactly:

```javascript
function emailShell({ title, preheader, bodyHtml, siteBase = "https://sc-cpe-web.pages.dev" }) {
```

Footer:
```html
  <div style="padding:16px 24px;border-top:1px solid #e6eaee;font-size:11px;color:#777;">
    You're receiving this because you registered at
    <a href="${siteBase}" style="color:#777;">Simply Cyber CPE</a>.<br/>
    Questions? Reply to this email.
  </div>
```

- [ ] **Step 3: Run tests**

```bash
bash scripts/test.sh
```

- [ ] **Step 4: Commit**

```bash
git add workers/purge/src/index.js
git commit -m "feat(email): mirror helpers in purge worker (button, code, progress, divider)"
```

---

### Task 3: Rewrite Registration + Code Resend Emails

**Files:**
- Modify: `pages/functions/api/register.js:13-51`
- Modify: `pages/functions/api/me/[token]/resend-code.js:18-52`

- [ ] **Step 1: Update register.js imports**

Add `emailButton`, `emailCode`, `emailDivider` to the import:

```javascript
import {
    ulid, randomCode, formatCode, randomToken, json, now, audit, clientIp, ipHash,
    isValidEmail, isValidName, verifyTurnstile, queueEmail,
    escapeHtml, emailShell, emailButton, emailCode, emailDivider, sha256Hex, rateLimit,
    killSwitched, killedResponse,
} from "../_lib.js";
```

- [ ] **Step 2: Rewrite `welcomeEmailBodies` in register.js**

```javascript
function welcomeEmailBodies({ legalName, code, dashboardToken, expiresAt, siteBase }) {
    const dashUrl = `${siteBase}/dashboard.html?t=${dashboardToken}`;
    const display = formatCode(code);
    const subject = `Your CPE verification code: ${display}`;
    const text = (
        `Hi ${legalName},\n\n` +
        `Welcome to Simply Cyber CPE! Here's your verification code:\n\n` +
        `    ${display}\n\n` +
        `Post this code in the YouTube chat during any Daily Threat Briefing.\n` +
        `Our poller sees it and links your YouTube channel to this account.\n\n` +
        `Your dashboard (bookmark this — it's your access URL):\n` +
        `  ${dashUrl}\n\n` +
        `Code expires ${expiresAt}.\n\n` +
        `If you did not register for SC-CPE, ignore this email —\n` +
        `the account stays inactive unless the code is used.\n\n` +
        `— Simply Cyber\n`
    );
    const bodyHtml = `
<p>Hi ${escapeHtml(legalName)},</p>
<p>Welcome to <strong>Simply Cyber CPE</strong>! Here's your verification code:</p>
${emailCode(display)}
<p style="text-align:center;">Post this code in the YouTube chat during any Daily Threat Briefing.</p>
${emailButton("Open Your Dashboard", dashUrl)}
${emailDivider()}
<p style="font-size:13px;color:#555;">Code expires <strong>${escapeHtml(expiresAt)}</strong>.
Our poller watches the chat and links your YouTube channel to this registration.
If you didn't register, ignore this email — the account stays inactive.</p>`;
    const html = emailShell({
        title: "Verification code",
        preheader: `Post this code in the YouTube chat to start earning CPE credits`,
        bodyHtml,
        siteBase,
    });
    return { subject, html, text };
}
```

- [ ] **Step 3: Update resend-code.js imports**

Add `emailButton`, `emailCode`, `emailDivider` to the import:

```javascript
import {
    ulid, randomCode, formatCode, json, now, audit, clientIp, ipHash,
    queueEmail, escapeHtml, emailShell, emailButton, emailCode, emailDivider,
    isSameOrigin, rateLimit, isValidToken,
} from "../../../_lib.js";
```

- [ ] **Step 4: Rewrite `bodies` in resend-code.js**

```javascript
function bodies({ legalName, code, expiresAt, dashboardUrl, siteBase }) {
    const display = formatCode(code);
    const subject = `Your new CPE code: ${display}`;
    const text =
        `Hi ${legalName},\n\n` +
        `Here's your fresh verification code:\n\n` +
        `    ${display}\n\n` +
        `Post it in the YouTube chat during any Daily Threat Briefing.\n` +
        `Code expires ${expiresAt}.\n\n` +
        `Dashboard: ${dashboardUrl}\n\n` +
        `— Simply Cyber\n`;
    const bodyHtml = `
<p>Hi ${escapeHtml(legalName)},</p>
<p>Here's your fresh verification code:</p>
${emailCode(display)}
<p style="text-align:center;">Post it in the YouTube chat during any Daily Threat Briefing.</p>
${emailButton("Open Your Dashboard", dashboardUrl)}
${emailDivider()}
<p style="font-size:13px;color:#555;">Code expires <strong>${escapeHtml(expiresAt)}</strong>.</p>`;
    return {
        subject,
        text,
        html: emailShell({
            title: "New verification code",
            preheader: `Fresh code ready — post it in the YouTube chat`,
            bodyHtml,
            siteBase,
        }),
    };
}
```

- [ ] **Step 5: Update call site in resend-code.js to pass `siteBase`**

Find the call to `bodies()` and add `siteBase` — it already has `dashboardUrl` which is derived from the request URL. Add:

```javascript
const siteBase = new URL(request.url).origin;
```

And pass `siteBase` to the `bodies()` call.

- [ ] **Step 6: Run tests**

```bash
bash scripts/test.sh
```

- [ ] **Step 7: Commit**

```bash
git add pages/functions/api/register.js pages/functions/api/me/\[token\]/resend-code.js
git commit -m "feat(email): rewrite registration + code resend emails with styled code blocks and gold CTAs"
```

---

### Task 4: Rewrite Recovery Email

**Files:**
- Modify: `pages/functions/api/recover.js:1-41`

- [ ] **Step 1: Update imports**

Add `emailButton` to the import:

```javascript
import {
    ulid, json, now, audit, clientIp, ipHash,
    isValidEmail, verifyTurnstile, escapeHtml, emailShell, emailButton, rateLimit,
    sha256Hex, killSwitched, killedResponse,
} from "../_lib.js";
```

- [ ] **Step 2: Rewrite `recoveryEmailBodies`**

```javascript
function recoveryEmailBodies({ legalName, dashboardUrl, siteBase }) {
    const subject = "Your CPE dashboard link";
    const text = (
        `Hi ${legalName},\n\n` +
        `Here's your Simply Cyber CPE dashboard link.\n` +
        `Bookmark it — this URL is your account credential.\n\n` +
        `  ${dashboardUrl}\n\n` +
        `If you did not request this, you can ignore the email.\n\n` +
        `— Simply Cyber\n`
    );
    const bodyHtml = `
<p>Hi ${escapeHtml(legalName)},</p>
<p>Here's your Simply Cyber CPE dashboard link. Bookmark it — this URL is your account credential.</p>
${emailButton("Open My Dashboard", dashboardUrl)}
<p style="word-break:break-all;font-family:Menlo,monospace;font-size:12px;color:#555;text-align:center;">
  ${dashboardUrl}
</p>
<p style="color:#666;font-size:12px;">If you did not request this, you can ignore
this email — no further action is taken.</p>`;
    return {
        subject,
        text,
        html: emailShell({
            title: "Dashboard recovery",
            preheader: "Bookmark this link — it's your account credential",
            bodyHtml,
            siteBase,
        }),
    };
}
```

- [ ] **Step 3: Update call site to pass `siteBase`**

Find where `recoveryEmailBodies` is called and pass `siteBase`:

```javascript
const siteBase = new URL(request.url).origin;
```

- [ ] **Step 4: Run tests**

```bash
bash scripts/test.sh
```

- [ ] **Step 5: Commit**

```bash
git add pages/functions/api/recover.js
git commit -m "feat(email): rewrite recovery email with gold CTA button"
```

---

### Task 5: Rewrite Cert Resend Email

**Files:**
- Modify: `pages/functions/api/admin/cert/[token]/resend.js:1-58`

- [ ] **Step 1: Update imports**

Add `emailButton`, `emailDivider` to the import:

```javascript
import {
    json, audit, clientIp, ipHash, isAdmin, queueEmail, now,
    escapeHtml, emailShell, emailButton, emailDivider, rateLimit,
} from "../../../../_lib.js";
```

- [ ] **Step 2: Rewrite `buildBodies`**

```javascript
function buildBodies({ recipientName, periodDisplay, cpeTotal, sessionsCount, downloadUrl, verifyUrl, issuerName, siteBase }) {
    const cpeStr = Number.isInteger(cpeTotal) ? `${cpeTotal}` : `${cpeTotal.toFixed(1)}`;
    const subject = `Your ${periodDisplay} Simply Cyber CPE certificate (re-issued link)`;
    const text =
        `Hi ${recipientName},\n\n` +
        `Here's a fresh download link for your ${periodDisplay} CPE certificate.\n\n` +
        `  CPE credit hours: ${cpeStr}\n` +
        `  Sessions attended: ${sessionsCount}\n\n` +
        `Download: ${downloadUrl}\n\n` +
        `Verify: ${verifyUrl}\n\n` +
        `— ${issuerName}\n`;
    const bodyHtml = `
<p>Hi ${escapeHtml(recipientName)},</p>
<p>Here's a fresh download link for your <strong>${escapeHtml(periodDisplay)}</strong> CPE certificate.</p>
<div style="background:#f4f6f8;border-radius:8px;padding:16px 20px;margin:16px 0;">
  <table style="width:100%;border-collapse:collapse;">
    <tr><td style="padding:4px 0;color:#5b6473;">CPE Credits</td><td style="padding:4px 0;font-weight:700;text-align:right;">${escapeHtml(cpeStr)}</td></tr>
    <tr><td style="padding:4px 0;color:#5b6473;">Sessions</td><td style="padding:4px 0;font-weight:700;text-align:right;">${escapeHtml(String(sessionsCount))}</td></tr>
    <tr><td style="padding:4px 0;color:#5b6473;">Period</td><td style="padding:4px 0;font-weight:700;text-align:right;">${escapeHtml(periodDisplay)}</td></tr>
  </table>
</div>
${emailButton("Download Signed PDF", downloadUrl)}
${emailDivider()}
<p style="font-size:13px;color:#555;">Auditors and employers can verify at:<br/>
<a href="${verifyUrl}" style="color:#0b3d5c;">${verifyUrl}</a></p>`;
    const html = emailShell({
        title: `${periodDisplay} certificate`,
        preheader: `${cpeStr} CPE credits — download your signed PDF`,
        bodyHtml,
        siteBase,
    });
    return { subject, html, text };
}
```

- [ ] **Step 3: Update call site to pass `siteBase`**

The admin endpoint derives URLs from env/request. Add `siteBase` to the call:

```javascript
const siteBase = new URL(request.url).origin;
```

Pass `siteBase` to `buildBodies()`.

- [ ] **Step 4: Run tests**

```bash
bash scripts/test.sh
```

- [ ] **Step 5: Commit**

```bash
git add pages/functions/api/admin/cert/\[token\]/resend.js
git commit -m "feat(email): rewrite cert resend email with card layout and gold CTA"
```

---

### Task 6: Rewrite Cert Nudge + Renewal Nudge Emails in Purge Worker

**Files:**
- Modify: `workers/purge/src/index.js` — `runCertNudges` (line 317) and `queueRenewalEmail` (line 447)

- [ ] **Step 1: Rewrite cert nudge HTML in `runCertNudges`**

Replace the inline HTML construction (lines 362-372) with:

```javascript
            const subject = `Quick check on your ${period} CPE cert`;
            const text =
                `Hi ${r.legal_name || "there"},\n\n` +
                `Your ${period} certificate was delivered — we want to make sure everything looks right.\n\n` +
                `Review: ${verifyUrl}\n` +
                `Dashboard: ${dashUrl}\n\n` +
                `If anything needs correcting, reply to this email or request a re-issue from your dashboard.\n\n` +
                `— Simply Cyber CPE\n`;
            const bodyHtml =
                `<p>Hi ${escapeHtml(r.legal_name || "there")},</p>` +
                `<p>Your <strong>${escapeHtml(period)}</strong> certificate was delivered — we want to make sure everything looks right.</p>` +
                emailButton("Review My Certificate", verifyUrl) +
                `<p style="font-size:13px;color:#555;">If anything needs correcting, reply to this email or request a re-issue from your dashboard.</p>`;
            const html = emailShell({
                title: "Certificate check",
                preheader: "Everything look right? Let us know in 30 seconds",
                bodyHtml,
                siteBase,
            });
```

- [ ] **Step 2: Rewrite renewal nudge HTML in `queueRenewalEmail`**

Replace the body construction (lines 451-480) with:

```javascript
    let subject, text, preheader;
    if (type === "milestone") {
        subject = `${rt.cert_name}: ${value}% of CPE earned!`;
        preheader = `You're ${value}% of the way to ${rt.cert_name} renewal`;
        text = `Hi ${name},\n\n` +
            `You're making great progress on ${rt.cert_name}!\n\n` +
            `${earned} / ${rt.cpe_required} CPE earned (${value}%)` +
            (daysLeft > 0 ? ` — ${daysLeft} days remaining.` : ".") +
            `\n\nDashboard: ${dashUrl}\n\n` +
            `— Simply Cyber CPE\n`;
    } else {
        subject = `${rt.cert_name}: ${daysLeft} days until deadline`;
        preheader = `${daysLeft} days until your ${rt.cert_name} deadline`;
        text = `Hi ${name},\n\n` +
            `Your ${rt.cert_name} renewal deadline is ${daysLeft} day${daysLeft === 1 ? "" : "s"} away — here's where you stand.\n\n` +
            `${earned} / ${rt.cpe_required} CPE earned (${value}%).\n\n` +
            `Dashboard: ${dashUrl}\n\n` +
            `— Simply Cyber CPE\n`;
    }

    const bodyHtml =
        `<p>Hi ${escapeHtml(name)},</p>` +
        (type === "milestone"
            ? `<p>You're making great progress on <strong>${escapeHtml(rt.cert_name)}</strong>!</p>`
            : `<p>Your <strong>${escapeHtml(rt.cert_name)}</strong> renewal deadline is <strong>${daysLeft} day${daysLeft === 1 ? "" : "s"}</strong> away — here's where you stand.</p>`) +
        emailProgress(value) +
        `<p style="text-align:center;color:#555;font-size:14px;">${earned}/${rt.cpe_required} CPE earned` +
        (daysLeft > 0 ? ` &bull; ${daysLeft} days remaining` : "") + `</p>` +
        emailButton("View My Dashboard", dashUrl);

    const html = emailShell({
        title: subject,
        preheader,
        bodyHtml,
        siteBase,
    });
```

- [ ] **Step 3: Run tests**

```bash
bash scripts/test.sh
```

- [ ] **Step 4: Commit**

```bash
git add workers/purge/src/index.js
git commit -m "feat(email): rewrite cert nudge + renewal nudge emails with gold CTAs and progress bars"
```

---

### Task 7: Add Headers Passthrough to Email Sender

**Files:**
- Modify: `workers/email-sender/src/index.js:173-202`

- [ ] **Step 1: Add `headers` passthrough in `sendViaResend`**

In the `sendViaResend` function, after parsing `payload`, build the request body with optional headers:

Replace the `body: JSON.stringify(...)` section (lines 195-201):

```javascript
        const resendBody = {
            from: env.FROM_EMAIL,
            to: [row.to_email],
            subject: row.subject,
            html,
            text,
        };
        if (payload.headers) resendBody.headers = payload.headers;
        resp = await fetch(RESEND_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${env.RESEND_API_KEY}`,
                "Content-Type": "application/json",
                "Idempotency-Key": row.idempotency_key,
            },
            body: JSON.stringify(resendBody),
            signal: controller.signal,
        });
```

- [ ] **Step 2: Run tests**

```bash
bash scripts/test.sh
```

- [ ] **Step 3: Commit**

```bash
git add workers/email-sender/src/index.js
git commit -m "feat(email): add headers passthrough to Resend API call for List-Unsubscribe support"
```

---

### Task 8: Wrap Certificate Delivery Email in Shell (Python)

**Files:**
- Modify: `services/certs/generate.py:683-746`

- [ ] **Step 1: Rewrite `build_email_bodies` HTML output**

Replace the standalone HTML with an emailShell-equivalent wrapper and card layout. The Python function builds the complete HTML string, so we need to replicate the shell inline:

```python
def build_email_bodies(
    *,
    recipient_name: str,
    period_display: str,
    attended_line: str,
    dates_line: str,
    cpe_total: float,
    sessions_count: int,
    verify_url: str,
    download_url: str,
    issuer_name: str,
) -> tuple[str, str]:
    if float(cpe_total).is_integer():
        cpe_str = f"{int(cpe_total)}"
    else:
        cpe_str = f"{float(cpe_total):.1f}"

    dates_text_block = f"  Sessions: {dates_line}\n" if dates_line else ""
    attended_sentence = f"Attendance recorded {attended_line}."

    text = (
        f"Hi {recipient_name},\n\n"
        f"Great news — your {period_display} CPE certificate is ready!\n"
        f"{attended_sentence}\n\n"
        f"  CPE credit hours: {cpe_str}\n"
        f"  Sessions attended: {sessions_count}\n"
        f"{dates_text_block}\n"
        f"Download your signed PDF:\n  {download_url}\n\n"
        f"Verify: {verify_url}\n\n"
        f"The PDF is PAdES-signed; most PDF readers show the digital signature "
        f"and certifying authority ({issuer_name}).\n\n"
        f"— {issuer_name}\n"
    )

    safe_name = html_mod.escape(recipient_name)
    preheader = f"{cpe_str} CPE credits earned — download your signed PDF"

    body_html = f"""
<p>Hi {safe_name},</p>
<p>Great news — your <strong>{period_display}</strong> CPE certificate is ready!</p>
<div style="background:#f4f6f8;border-radius:8px;padding:16px 20px;margin:16px 0;">
  <table style="width:100%;border-collapse:collapse;">
    <tr><td style="padding:4px 0;color:#5b6473;">CPE Credits</td><td style="padding:4px 0;font-weight:700;text-align:right;">{cpe_str}</td></tr>
    <tr><td style="padding:4px 0;color:#5b6473;">Sessions</td><td style="padding:4px 0;font-weight:700;text-align:right;">{sessions_count}</td></tr>
    <tr><td style="padding:4px 0;color:#5b6473;">Period</td><td style="padding:4px 0;font-weight:700;text-align:right;">{period_display}</td></tr>
  </table>
</div>
<p style="text-align:center;margin:24px 0;">
  <a href="{download_url}" style="display:inline-block;background:#d4a73a;color:#0b3d5c;
     font-weight:bold;padding:12px 28px;border-radius:6px;text-decoration:none;
     font-size:14px;letter-spacing:0.02em;">Download Signed PDF</a>
</p>
<hr style="border:none;border-top:1px solid #e6eaee;margin:20px 0;">
<p style="font-size:13px;color:#555;">Auditors and employers can verify at:<br/>
<a href="{verify_url}" style="color:#0b3d5c;">{verify_url}</a></p>
<p style="font-size:12px;color:#777;">The PDF is PAdES-signed; most PDF readers show the
digital signature and certifying authority ({html_mod.escape(issuer_name)}).</p>"""

    safe_title = html_mod.escape(f"{period_display} certificate")
    html = f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f6f8;font-family:Helvetica,Arial,sans-serif;color:#111;line-height:1.5;">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">{html_mod.escape(preheader)}</span>
<div style="max-width:580px;margin:0 auto;background:#fff;">
  <div style="background:#0b3d5c;padding:18px 24px;">
    <div style="color:#fff;font-size:11pt;letter-spacing:0.18em;text-transform:uppercase;">Simply Cyber CPE</div>
    <div style="color:#d4a73a;font-size:9pt;margin-top:2px;">{safe_title}</div>
  </div>
  <div style="padding:24px;">
    {body_html}
  </div>
  <div style="padding:16px 24px;border-top:1px solid #e6eaee;font-size:11px;color:#777;">
    You're receiving this because you registered at
    <a href="https://sc-cpe-web.pages.dev" style="color:#777;">Simply Cyber CPE</a>.<br/>
    Questions? Reply to this email.
  </div>
</div>
</body></html>"""
    return html, text
```

- [ ] **Step 2: Commit**

```bash
git add services/certs/generate.py
git commit -m "feat(email): wrap cert delivery in emailShell with card layout and gold CTA"
```

---

### Task 9: Add DMARC Instructions to Runbook

**Files:**
- Modify: `docs/RUNBOOK.md`

- [ ] **Step 1: Add DMARC section to RUNBOOK.md**

Add a section near email/Resend documentation:

```markdown
## DMARC Record

Add a DNS TXT record for `_dmarc.signalplane.co`:

```
v=DMARC1; p=none; rua=mailto:dmarc-reports@signalplane.co
```

This enables DMARC reporting without enforcing policy (`p=none`).
DKIM is already configured via Resend. SPF is set.
Once reports confirm alignment, consider escalating to `p=quarantine`.

To verify:
```bash
dig TXT _dmarc.signalplane.co +short
```
```

- [ ] **Step 2: Commit**

```bash
git add docs/RUNBOOK.md
git commit -m "docs: add DMARC setup instructions to runbook"
```

---
