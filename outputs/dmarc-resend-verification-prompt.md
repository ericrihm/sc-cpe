# DMARC + Resend Verification Prompt

Use this for the next operator/agent pass on SC-CPE email security.

---

You are working in `/Users/ericrihm/dev/sc-cpe` on `main`.

Goal: finish the launch-blocking email authentication check for `signalplane.co`, specifically DMARC and Resend domain verification. This is mostly DNS/operator work, not application code.

Known facts from the repo and live DNS as of 2026-04-27:

- `CLAUDE.md` records the gap: Resend DKIM/SPF are present, but `signalplane.co` has no DMARC record.
- `docs/LAUNCH_READINESS.md` marks DMARC as P0 before public announcement.
- `dig TXT _dmarc.signalplane.co +short` currently returns no record.
- `dig TXT signalplane.co +short` returns only Namecheap forwarding SPF: `v=spf1 include:spf.efwd.registrar-servers.com ~all`.
- `dig TXT send.signalplane.co +short` returns Resend/SES SPF: `v=spf1 include:amazonses.com ~all`.
- `dig MX send.signalplane.co +short` returns `10 feedback-smtp.us-east-1.amazonses.com.`
- `dig TXT resend._domainkey.signalplane.co +short` returns a DKIM public key.

Tasks:

1. Verify the Resend dashboard for `signalplane.co`.
   - Confirm the domain is verified.
   - Confirm DKIM passes.
   - Confirm the Return-Path/custom return path is `send.signalplane.co` or whatever Resend says is active.
   - Confirm the From address used by Cloudflare secrets (`FROM_EMAIL`) is on the verified domain.

2. Add the DMARC TXT record in DNS:

   ```text
   Host/name: _dmarc
   Type: TXT
   Value: v=DMARC1; p=none; rua=mailto:certs@signalplane.co
   ```

   Use `certs@signalplane.co` because it is the monitored launch inbox. Do not use `dmarc-reports@signalplane.co` unless that mailbox/forwarder is confirmed live.

3. Verify propagation:

   ```bash
   dig TXT _dmarc.signalplane.co +short
   ```

   Expected output includes:

   ```text
   v=DMARC1; p=none; rua=mailto:certs@signalplane.co
   ```

4. Send a test email through the normal SC-CPE/Resend path to a mailbox where headers can be inspected.
   - Confirm `dkim=pass`.
   - Confirm `spf=pass` if the active Return-Path is aligned or expected by Resend.
   - Confirm `dmarc=pass`.
   - If DMARC fails, inspect header alignment: visible `From`, DKIM `d=`, SPF/Return-Path domain.

5. After a short observation window with clean reports, tighten DMARC to the launch target from `docs/LAUNCH_READINESS.md`:

   ```text
   v=DMARC1; p=quarantine; rua=mailto:certs@signalplane.co; adkim=s; aspf=s; fo=1
   ```

6. Update docs only after DNS is actually live:
   - `README.md`: remove “DMARC DNS pending”.
   - `CLAUDE.md`: remove the known gap entry or replace it with the verified date.
   - `docs/LAUNCH_READINESS.md`: check off the DMARC P0 item with the verification date.
   - `docs/RUNBOOK.md`: keep the verification command and current record.

Report back with the exact DNS records observed, the Resend dashboard status, and the test email authentication results.
