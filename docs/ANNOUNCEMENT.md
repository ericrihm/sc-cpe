# Launch announcement — copy bank

Grab-and-go text for the channels you plan to post. Adjust tone/length
per channel; the technical claims should stay identical everywhere so a
sharp reader comparing posts doesn't see inconsistency.

All copy below is public-ready — nothing here undersells with "beta"
language. The service runs on the same infrastructure it'll run on at
scale, with the same signing key, the same audit chain, the same
verification portal.

---

## LinkedIn / Discord long-form (~200 words)

> **Simply Cyber CPE is live.**
>
> Automatic, cryptographically verifiable CPE / CEU certificates for
> everyone who shows up to the Simply Cyber Daily Threat Briefing.
> Post at least one chat message during the live broadcast → earn
> 0.5 CPE for that session → receive a PAdES-T signed PDF you can
> submit directly to (ISC)², ISACA, CompTIA, or any CE body that
> accepts self-attested continuing education.
>
> What matters for a security audience:
>
> • **Every certificate is independently verifiable without contacting
>   us.** The PDF is PAdES-T signed with an RFC‑3161 trusted timestamp;
>   the signing cert fingerprint is printed on the face of the
>   document; every state transition (registration → attendance →
>   issue → delivery) lands in an append-only SHA‑256 hash-chained
>   audit log protected by a UNIQUE INDEX that makes chain forks
>   structurally impossible.
>
> • **Drop your PDF onto https://sc-cpe-web.pages.dev/verify.html** —
>   the browser recomputes the hash locally (file never leaves your
>   machine) and compares against the registered value. Mismatched PDF
>   with a valid token? Flagged immediately.
>
> Full source open at github.com/ericrihm/sc-cpe. Security disclosure
> policy at /.well-known/security.txt.
>
> Register: https://sc-cpe-web.pages.dev/

## Twitter / X short-form (~280 chars)

> Simply Cyber CPE is live.
>
> Post in the Daily Threat Briefing live chat → get a PAdES-T signed,
> RFC-3161 timestamped CPE cert. Drag the PDF onto
> sc-cpe-web.pages.dev/verify.html to confirm the hash locally. Full
> source open at github.com/ericrihm/sc-cpe.

## Email / mailing-list subject + body

**Subject:** Simply Cyber CPE is live — automatic CEU credit for Daily
Threat Briefing attendance

> Attending the Daily Threat Briefing? You can now earn automatic
> CPE / CEU credit for it.
>
> Sign up once at https://sc-cpe-web.pages.dev/. Post any qualifying
> chat message during a live briefing and the system credits you
> 0.5 CPE for that session. Monthly bundled PDFs (or on-demand
> per-session PDFs) arrive signed and ready for your CE portal.
>
> Every cert is cryptographically verifiable without talking to us:
>
>   • PAdES-T signature + RFC-3161 timestamp embedded in the PDF
>   • Public verification at /verify.html with client-side SHA-256
>     match
>   • Hash-chained audit log, public source at
>     github.com/ericrihm/sc-cpe
>
> Known first-week polish items: mobile + screen-reader accessibility
> review (documented issues triaged as non-blocking; fixes ship under
> auto-deploy), and Monday 2026-04-20's live briefing will be the
> first captured evidentiary run through the full register → post →
> credit → issue → verify cycle.
>
> Security disclosure: certs@signalplane.co with `[SECURITY]` prefix
> (see /.well-known/security.txt for SLAs).
>
> — Simply Cyber LLC

---

## Talking points if someone asks live

If a CISSP in the Daily Threat Briefing chat asks pointed questions,
the one-line answers:

- _"What keeps someone from forging a cert?"_ PAdES signature chain +
  the embedded signing-cert fingerprint + server-side pdf_sha256
  match. A hand-crafted PDF won't match the registered hash on
  /verify.html.
- _"What keeps someone from stealing credit for a briefing I attended?"_
  One YouTube channel per SC-CPE account, bound at verification. Chat
  messages attribute via YouTube's own user identity.
- _"What happens if I lose my dashboard link?"_ `/recover.html` emails
  a fresh URL to the address on file. Or rotate via the
  **Rotate dashboard link** action if you think it leaked.
- _"Where's revocation?"_ `/api/crl.json` — public, machine-readable,
  refreshed on every revoke.
- _"You're on pages.dev not the apex domain."_ `cpe.simplycyber.io`
  DNS is queued. Canonical origin until then is
  `sc-cpe-web.pages.dev`. Either resolves.
- _"Who do I email about a security issue?"_ `certs@signalplane.co`
  with `[SECURITY]` in the subject. 3-day acknowledgement SLA per
  security.txt.

## Do NOT say

- "Beta." It's not — same prod infrastructure, same signing key, same
  audit chain as it'll run on at 10x scale.
- "Try it out." It's a service, not an experiment.
- Specific uptime / acceptance promises beyond what `docs/SLO.md` says.
- "(ISC)² / ISACA / CompTIA will accept these." They accept self-
  attested continuing education; the cert format matches their
  category. We can't guarantee any individual body's acceptance
  decision.
