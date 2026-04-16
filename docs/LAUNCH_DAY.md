# Launch-day playbook

Hour-by-hour, action-by-action. This is the day you run the checklist
items in `LAUNCH_READINESS.md` against reality (not against the idea
of reality) and then announce.

## T-24 hours

### Inbox filter setup (Gmail receiving `certs@signalplane.co`)

Set these filters on the mailbox that receives forwarded mail from
`certs@signalplane.co`. Use **Settings → Filters and Blocked Addresses
→ Create a new filter**.

| Subject contains | Apply label | Also |
| --- | --- | --- |
| `[SECURITY]` | SC-CPE / SECURITY | star, mark important |
| `[PRIVACY]` | SC-CPE / PRIVACY | star |
| `[CERT]` | SC-CPE / CERT-DISPUTE | star |
| `[ACCOUNT]` | SC-CPE / SUPPORT | — |
| `[SC-CPE]` (starts with) | SC-CPE / OPS-AUTO | skip inbox, mark read |
| `Report domain:` | SC-CPE / DMARC-AUTO | skip inbox, mark read |
| `Simply Cyber CPE — your verification code:` | SC-CPE / TXN-RECEIPT | skip inbox |
| `Your Simply Cyber CPE dashboard link` | SC-CPE / TXN-RECEIPT | skip inbox |
| `Simply Cyber CPE — your dashboard link has been rotated` | SC-CPE / TXN-RECEIPT | skip inbox |

Send a test from a different mailbox with subject `[SECURITY] test`.
Confirm it lands labelled `SECURITY`, starred, in Important. Remove
the test.

### External-inbox smoke

- Register with a **Gmail** address you don't normally use at
  https://sc-cpe-web.pages.dev/. Confirm the verification email arrives
  within 2 minutes. Delete the account afterwards.
- Do the same with an **Outlook.com / Hotmail** address. Outlook is
  fussy with Resend; if it lands in Junk, that's a deliverability-flag
  worth knowing before announcement.
- Try sending **TO** `certs@signalplane.co` from both mailboxes —
  confirms the receive path works end-to-end in both directions.

### Full grep for dead addresses

```sh
grep -rn 'contact@signalplane\|privacy@signalplane\|security@signalplane\|dmarc-reports@' \
  pages/ docs/ README.md services/ workers/ 2>/dev/null || echo "clean"
```

Should print `clean`.

### Prepare the verify demo

Download a real cert you've already been issued (or regenerate from
`scripts/generate_sample_cert.py` if you don't have one). Save it locally.
Open `/verify.html`. Drag the PDF in. Confirm the green "matches"
message. This is the demo you'll show if anyone asks "does this thing
really verify."

Also pre-fill the verify URL with a known-good `public_token` so you
can paste a live-link into the announcement channel if needed.

## T-1 hour — war-room setup

Open these in a single browser window / Arc space:

1. `https://sc-cpe-web.pages.dev/status.html`
2. `https://sc-cpe-web.pages.dev/admin.html` (logged in)
3. `https://github.com/ericrihm/sc-cpe/actions/workflows/watchdog.yml`
4. `https://github.com/ericrihm/sc-cpe/actions/workflows/smoke.yml`
5. `https://github.com/ericrihm/sc-cpe/actions/workflows/cert-sign-pending.yml`
6. `https://github.com/ericrihm/sc-cpe/actions/workflows/deploy-prod.yml`
7. Discord channel that receives webhook alerts
8. Gmail inbox (the one receiving `certs@signalplane.co`)

Take screenshots of the status page and admin dashboard showing a
clean baseline — these are your "before" shots when someone later
asks what the launch looked like.

## T-0 — announce

- Announce in whatever channel you planned (Simply Cyber community,
  Twitter/X, LinkedIn, etc.).
- First 10 minutes: watch the admin dashboard. Expect `email_outbox.queued`
  to tick up as signups arrive; it should drain within 2 minutes per batch.
- If queue depth exceeds 100 or oldest-queued passes 5 min: the warning
  banner will go critical and watchdog will fire a Discord alert. Stay
  calm — the sender is doing its job, just slower than the inflow.
  Kill switch on `register` is available if inflow is clearly abuse,
  not legitimate.
- Keep a notepad. Every odd thing you see, write it down with a
  timestamp. You'll want it for the T+24 retro.

## T+1 to T+6 hours — watch window

Heaviest inflow is usually first 30 minutes, tapering over 6 hours.
Check these every 30 min:

- `status.html`: all five cron sources beating.
- Admin dashboard: `email_outbox.queued` trending down to zero
  between bursts. `email_outbox.failed` stays at 0.
- Discord: any alerts? Each one deserves a reply in your own notepad
  ("investigated, cause X, action Y").
- Inbox: any `[SECURITY]` or `[PRIVACY]` mail? Those get same-hour
  responses.

## Live briefing — the evidentiary proof flow

This one has to happen during a real ET-weekday 08:00–11:00 window. Do
it on **announcement day or the day after**. Everything else can be
simulated; this can't. Script:

### 1. Register (browser A, a fresh Gmail you'll delete after)

- Go to the registration page, fill in legal name + email.
- Watch the admin dashboard: `users.pending` ticks up by 1.
- Check the email: verification code + dashboard URL arrive within
  2 minutes.

### 2. Post the code in live chat (browser B, signed into YouTube)

- Open the Daily Threat Briefing stream.
- Post a chat message containing only your 8-char code.

### 3. Confirm credit

- Within ~60 seconds, the user dashboard (browser A) should flip the
  "today" card from "waiting" to "credited".
- Admin dashboard: `last_24h.attendance` ticks up.

### 4. Request a per-session cert

- From the user dashboard, click "Request cert for this session".
- Within 2 hours (usually much sooner), an email arrives with the PDF.

### 5. Verify the PDF

- Open the verify URL from the email or from the QR on the cert.
- Drag the PDF onto `/verify.html`.
- Confirm **green "matches the certificate registered under that token"**
  and the recipient name matches what you registered with.

### 6. Clean up

- Delete the test account from the dashboard.
- Note: the cert is retained under the Art. 17(3)(e) carve-out (this
  is correct behaviour, not a bug).

If any step fails, **don't announce** — fix first. All six steps
passing is the definitive "it works" signal.

## Mobile + accessibility pass

On real devices, not an emulator. **20 min per page**, four public
pages:

### Devices

- Mobile Safari on iPhone (narrow screen, most community members).
- Chrome Android on a mid-range phone.
- Desktop Chrome + keyboard-only.
- Desktop VoiceOver (macOS) OR TalkBack (Android) for one full pass.

### Pages

1. `/` (registration)
2. `/recover.html`
3. `/dashboard.html?t=<token>` (use your own)
4. `/verify.html?t=<public_token>` (use a real cert)

### Acceptance criteria

- All content readable without horizontal scroll at 375px width.
- Every form control has a visible focus outline when tabbed to.
- Every action button can be triggered with Space/Enter.
- No form control depends on colour alone (error = "Required" text,
  not just a red border).
- Screen reader announces:
  - Page title
  - Form labels
  - Error messages on submit
  - Status updates (credit received, cert ready)
- Dashboard's "Rotate dashboard link" confirmation dialog reads
  sensibly via screen reader.

### Record findings

Any issue found gets a GitHub issue with the `a11y` label. P0 = blocks
a user from completing a task. P1 = works but awkward. P2 = polish.
Plan to ship any P0 fixes within 72h of discovery.

## T+24 hours — retro

- Count signups.
- Pull the queue-depth graph from `admin.html` history (or note the
  peak you saw).
- Review your war-room notepad. Every oddity either has a ticket or
  a "known and accepted" rationale.
- Update `docs/SLO.md` with the first real actuals.
- Any `[SECURITY]` mail still open? Triage it.

## What "good" looks like

- All five health sources green for the whole 24h.
- Queue depth peaked under 200, drained between bursts.
- No `level: critical` warnings fired.
- Discord: only the Discord test alert and any legitimate cron failures.
- Zero forged-cert reports.
- Zero revocations (excepting ones you did on purpose during the test
  flow and promptly cleaned up).
