# Email Improvements — Design Spec

## Overview

Elevate all 11 SC-CPE email types from "functional system notifications" to "polished product communications." Three dimensions: user experience (copy, CTAs, information hierarchy), visual polish (buttons, progress bars, code display), and deliverability (DMARC, List-Unsubscribe, preview text).

No changes to email_outbox schema or Resend integration pattern. One small addition to the email-sender worker (optional `headers` passthrough). Otherwise purely content + presentation, achieved by enhancing the shared email shell and rewriting each email's subject, preheader, and body.

## Current State

**Email shell** (`emailShell()` in `_lib.js:267` and `purge/index.js:286`):
- Navy header `#0b3d5c` with "SIMPLY CYBER CPE" + gold subtitle
- Max-width 580px, white body, grey footer
- Hidden preheader span for email client preview text
- Footer: "You're receiving this because you registered for Simply Cyber CPE."

**Cert delivery email** (`generate.py:683`):
- Separate HTML (not using emailShell — has no header/footer wrapper)
- Has a styled "Download signed PDF" button
- Plain `<ul>` for CPE details

**11 email types**, 4 categories:
1. Transactional: registration, code resend, recovery
2. Certificate: monthly cert, per-session cert, cert resend, cert nudge
3. Admin: security alerts, weekly digest
4. Renewal: milestone nudge, deadline nudge

## Changes

### 1. Enhanced Email Shell

Modify `emailShell()` in both `_lib.js` and `purge/index.js` (must stay in sync).

**Add helper functions** (in `_lib.js`, mirrored in purge worker):

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

**Update emailShell signature** to accept an optional `siteBase` parameter (callers derive from `request.url`; purge worker uses `SITE_BASE` env var):

```javascript
export function emailShell({ title, preheader = "", bodyHtml, siteBase = "https://sc-cpe-web.pages.dev" })
```

**Update emailShell footer:**
```html
<div style="padding:16px 24px;border-top:1px solid #e6eaee;font-size:11px;color:#777;">
  You're receiving this because you registered at
  <a href="${siteBase}" style="color:#777;">Simply Cyber CPE</a>.<br/>
  Questions? Reply to this email.
</div>
```

### 2. Email Rewrites

#### Registration Email (`register.js:14`)

**Subject:** `Your CPE verification code: ${display}` (was: "Simply Cyber CPE — your verification code")

**Preheader:** `Post this code in the YouTube chat to start earning CPE credits`

**Body rewrite — information hierarchy:**
1. Greeting with name
2. Large code block (using `emailCode()`) — the most important thing
3. One-sentence instruction: "Post this code in the YouTube chat during any Daily Threat Briefing"
4. Gold CTA button: "Open Your Dashboard" (using `emailButton()`)
5. Divider
6. Details section (smaller text): code expiry, how the poller works, safety note

#### Code Resend Email (`resend-code.js:19`)

**Subject:** `Your new CPE code: ${display}` (was: "Simply Cyber CPE — your new verification code")

**Preheader:** `Fresh code ready — post it in the YouTube chat`

**Body:** Same structure as registration but with "Here's your fresh verification code" instead of welcome text. No need to re-explain the full system.

#### Recovery Email (`recover.js:7`)

**Subject:** `Your CPE dashboard link` (was: "Your Simply Cyber CPE dashboard link")

**Preheader:** `Bookmark this link — it's your account credential`

**Body rewrite:**
1. Greeting
2. Gold CTA button: "Open My Dashboard" (replace the navy button)
3. Small monospace URL below button (keep for copy-paste)
4. Safety note

#### Certificate Delivery (`generate.py:683`)

**Subject:** Keep as-is (already good: "Your {period} CPE certificate")

**Preheader:** `${cpe_str} CPE credits earned — download your signed PDF`

**Body rewrite:**
1. Congratulatory opening: "Great news — your ${period} CPE certificate is ready!"
2. CPE summary as a styled card (not a `<ul>`):
   ```
   ┌─────────────────────────────┐
   │  CPE Credits: 5             │
   │  Sessions: 12               │
   │  Period: March 2026         │
   └─────────────────────────────┘
   ```
3. Gold CTA button: "Download Signed PDF"
4. Divider
5. Verification link section: "Auditors and employers can verify at: [link]"
6. Small text: PAdES signature explanation

**Wrap in emailShell** — currently the cert email has no header/footer. Add the shared shell for brand consistency.

#### Cert Resend (`admin/cert/[token]/resend.js`)

**Subject:** Keep as-is.

**Body:** Same structure as cert delivery but with "Here's a fresh download link for your certificate" opening instead of congratulatory text.

#### Cert Nudge (`purge/index.js`, `runCertNudges`)

**Subject:** `Quick check on your ${period} CPE cert` (was: "Your {period} CPE cert — a quick check?")

**Preheader:** `Everything look right? Let us know in 30 seconds`

**Body rewrite:**
1. Friendly opening: "Your ${period} certificate was delivered — we want to make sure everything looks right."
2. Gold CTA button: "Review My Certificate"
3. Small text: "If anything needs correcting, reply to this email or request a re-issue from your dashboard."

#### Renewal Milestone Nudge (`purge/index.js`, `runRenewalNudges`)

**Subject:** Keep as-is (already good with percentage).

**Preheader:** `You're ${pct}% of the way to ${certName} renewal`

**Body rewrite:**
1. Celebratory opening: "You're making great progress on ${certName}!"
2. Progress bar (using `emailProgress(pct)`)
3. Stats: "${earned}/${required} CPE earned • ${daysLeft} days remaining"
4. Gold CTA button: "View My Dashboard"

#### Renewal Deadline Nudge

**Subject:** Keep as-is.

**Preheader:** `${daysLeft} days until your ${certName} deadline`

**Body rewrite:**
1. Direct opening: "Your ${certName} renewal deadline is ${daysLeft} days away — here's where you stand."
2. Progress bar (using `emailProgress(pct)`)
3. Stats: "${earned}/${required} CPE earned • deadline: ${deadline}"
4. Gold CTA button: "View My Dashboard"

#### Weekly Digest (admin-only, plain text)

No visual changes — admin emails stay plain text. Minor copy improvements:
- Add section headers with `===` dividers for readability
- Add a one-line summary at the top: "7-day summary: X registrations, Y verifications, Z certs issued"

#### Security Alerts (admin-only, plain text)

No changes — format is correct for security alerting (scannable, timestamped).

### 3. Deliverability Improvements

#### DMARC Record

Add DNS TXT record for `_dmarc.signalplane.co`:
```
v=DMARC1; p=none; rua=mailto:dmarc-reports@signalplane.co
```

This is a DNS change, not a code change. Document in the runbook.

#### List-Unsubscribe Header

For nudge and digest emails only (not transactional), add the `List-Unsubscribe` header via Resend:

```javascript
headers: {
    "List-Unsubscribe": `<mailto:unsubscribe@signalplane.co?subject=unsubscribe-${userId}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
}
```

This requires modifying the email-sender worker to pass headers from `payload_json` to the Resend API call. Add an optional `headers` field to the payload.

#### Resend Headers Support

Modify the email-sender worker's Resend API call to include custom headers from `payload_json.headers` if present:

```javascript
const payload = JSON.parse(row.payload_json);
const resendBody = {
    from: env.FROM_EMAIL,
    to: [row.to_email],
    subject: row.subject,
    html: payload.html_body,
    text: payload.text_body,
};
if (payload.headers) resendBody.headers = payload.headers;
```

## Files Modified

| File | Changes |
|------|---------|
| `pages/functions/_lib.js` | Add `emailButton()`, `emailCode()`, `emailProgress()`, `emailDivider()`. Update `emailShell()` footer. |
| `pages/functions/api/register.js` | Rewrite `welcomeEmailBodies()` — new subject, preheader, body using helpers. |
| `pages/functions/api/recover.js` | Rewrite `recoveryEmailBodies()` — new subject, preheader, gold button. |
| `pages/functions/api/me/[token]/resend-code.js` | Rewrite `bodies()` — new subject, preheader, shorter body. |
| `pages/functions/api/admin/cert/[token]/resend.js` | Rewrite `buildBodies()` — new body structure. |
| `workers/purge/src/index.js` | Mirror new helpers. Rewrite cert nudge + renewal nudge bodies. Update `emailShell()`. |
| `workers/email-sender/src/index.js` | Add `headers` passthrough to Resend API call. |
| `services/certs/generate.py` | Wrap cert email in emailShell equivalent. Rewrite body with card layout. Add preheader. |
| `docs/RUNBOOK.md` | Add DMARC setup instructions. |

## What Does NOT Change

- `email_outbox` schema — no new columns
- Email-sender retry logic — unchanged
- Idempotency key patterns — unchanged
- Trigger conditions — same events send same emails
- Admin alert format — stays plain text
- Resend API integration — same endpoint, just optional headers field added

## Testing

- Send test emails via the existing registration flow on the preview environment
- Verify emails render correctly in Gmail, Outlook, Apple Mail (the big 3)
- Check mobile rendering (Outlook mobile is notoriously tricky)
- Verify List-Unsubscribe header appears in Gmail (shows unsubscribe link in header)
- Litmus or Email on Acid for cross-client testing (optional, manual)
