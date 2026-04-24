# SC-CPE: Verifiable CPE Certificates for Simply Cyber

**What if every CPE certificate your community earns was cryptographically verifiable -- by anyone, forever, without calling you?**

## The problem

Continuing education is built on trust. Attendees self-report hours. Paper certs are trivial to forge. CE bodies audit randomly and have no efficient way to verify attendance claims. The result: fraud undermines the value of legitimate professional development.

## The solution

SC-CPE watches the Daily Threat Briefing live chat, matches per-user verification codes, and auto-issues **PAdES-T signed PDF certificates** anchored to an append-only, hash-chained audit trail. Every certificate is independently verifiable -- offline, years later, without contacting the issuer.

## How it works

1. **Register** at the SC-CPE portal (email + legal name, one time)
2. **Post your code** in YouTube live chat during the briefing
3. **Certificate arrives** by email -- per-session (~2 hours) or monthly bundle

That's it. No manual tracking, no spreadsheets, no honor system.

## What makes it different

- **Offline verification**: Anyone -- employers, auditors, ISACA, ISC2 -- can verify a cert by checking the PDF signature and matching its SHA-256 hash against the public registry. No API key, no account, no phone call.
- **Anti-fraud**: Time-gated attendance (pre-stream chat and replays don't count), contested-code detection, and a hash-chained audit log where forks fail at insert time.
- **CE-body compatible**: Certificates include all seven ISACA audit-evidence fields. Format matches CompTIA CEU and ISC2 CPE submission requirements.

## Live demo

Verify a certificate yourself: **[sc-cpe-web.pages.dev/verify.html](https://sc-cpe-web.pages.dev/verify.html)**

Drop any SC-CPE PDF on the page. The browser recomputes its SHA-256 locally and confirms it matches the registered hash. Nothing leaves the device.

## By the numbers

- **9** registered users (early access)
- **1** certificate issued
- **200+** sessions tracked

20 weekday briefings/month = 10 CPE. Enough to cover a significant chunk of most annual renewal requirements.

## Community features

- Attendance streaks and leaderboard
- Shareable achievement badges
- Renewal tracking across CompTIA, ISC2, and ISACA
- Per-session or bundled cert delivery (user's choice)
- Dashboard with full attendance history

## The ask

SC-CPE is fully open-source, running today, and ready to scale. We'd love to make this official for the Simply Cyber community.

Let's talk: [certs@signalplane.co](mailto:certs@signalplane.co)
