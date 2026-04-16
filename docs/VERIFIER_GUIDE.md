# Verifier guide — for CE-portal auditors and relying parties

You received an SC-CPE certificate (PDF) from someone who claims live
attendance at the Simply Cyber Daily Threat Briefing. This one-page guide
explains exactly what the certificate attests to and how to verify it
independently — without contacting the issuer.

## The one-sentence answer

An SC-CPE certificate proves that the named recipient's registered
YouTube channel posted at least one qualifying chat message during each
Daily Threat Briefing on the stated date(s), during the live broadcast
window. One 30-minute briefing = 0.5 CPE / CEU.

## Three-step verification

### 1. Check the PDF signature

The cert is signed using the **PAdES-T** standard (PDF Advanced Electronic
Signatures with trusted timestamp). Any PAdES-aware PDF reader — Adobe
Acrobat, Foxit, recent macOS Preview, pdfsig on Linux — will show the
signer's certificate and timestamp. Confirm:

- **Signer common name** = `Simply Cyber LLC` (or the current key holder
  named on the PDF itself).
- **Signing-cert SHA-256 fingerprint** matches the value printed on the
  face of the certificate. If the reader shows a different fingerprint,
  the PDF was re-signed by someone else; reject it.
- **RFC 3161 timestamp** is present. This is what makes the signature
  outlive the signer's cert expiry — without a timestamp, the signature
  stops verifying when the signer cert expires.

### 2. Confirm the PDF matches our registered hash

Open https://sc-cpe-web.pages.dev/verify.html and paste the certificate's
**public token** (printed on the PDF under the QR code). You'll see the
recipient name, period, CPE total, and the **registered SHA-256 of the
issued PDF**.

Then drag the PDF onto the page. Your browser computes its SHA-256
locally (nothing leaves your device) and compares. A green "matches the
certificate registered under that token" confirms the PDF you're holding
is the exact artefact we issued. A red mismatch means the token is
registered but the PDF isn't — you have a lookalike, not a real cert.

### 3. Check revocation

The same verify page surfaces revocation status. If the certificate is
marked **REVOKED**, the page shows a revocation reason class
(`issued_in_error`, `superseded`, `subject_request`, `key_compromise`,
`other`). Additionally, a public revocation list is available at
https://sc-cpe-web.pages.dev/api/crl.json — machine-readable, same data.

## What this cert does *not* attest to

- **Identity verification.** We do not perform KYC or government-ID
  checks. Identity is established by possession of the email address
  provided at registration and the YouTube channel bound via
  out-of-band code exchange. We attest that a *channel-holder* who
  attested to the given legal name posted qualifying messages — not
  that the channel-holder is who they say they are.
- **Continuous viewing.** Attendance is a binary signal: one qualifying
  chat message during the live window earns credit for the whole
  session.
- **Acceptance by your CE body.** (ISC)², ISACA, CompTIA, and others
  accept self-attested continuing education; the SC-CPE cert format
  matches the category these programs define. We cannot guarantee
  acceptance — that remains each body's policy call.

## Audit chain

Every state transition in SC-CPE — registration, chat-code match,
attendance credit, cert issuance, delivery, revocation — writes an
append-only row to a SHA-256 hash-chained audit log. A `UNIQUE INDEX` on
`prev_hash` makes chain forks structurally impossible. If you need a
higher level of assurance than signature + hash-match:

- `GET /api/admin/audit-chain-verify` (admin-gated) walks the full chain
  and confirms no tampering. Contact the issuer for a one-shot verify if
  an auditor specifically requests it.
- The offline verifier `scripts/verify_audit_chain.py` in the public
  [SC-CPE source repo](https://github.com/ericrihm/sc-cpe) replays the
  chain against a D1 export independently of the running service.

## Questions, disputes, or suspected forgery

- **Report suspected forgery or credential fraud:**
  `security@signalplane.co` (see
  https://sc-cpe-web.pages.dev/.well-known/security.txt for the
  full disclosure policy and SLAs).
- **Revocation request (e.g., you're a CE body that determined a cert
  was issued in error):** `contact@signalplane.co`. Include the
  cert's public token.
- **Policy questions:** see https://sc-cpe-web.pages.dev/privacy.html
  and https://sc-cpe-web.pages.dev/terms.html.

## Quick-copy explanation for CE portal upload forms

> Simply Cyber CPE (SC-CPE) certificate of live attendance at the
> Simply Cyber Daily Threat Briefing. The certificate is
> cryptographically signed (PAdES-T with RFC-3161 timestamp), anchored
> to an append-only hash-chained audit log, and independently verifiable
> at https://sc-cpe-web.pages.dev/verify.html. One 30-minute briefing
> yields 0.5 CPE / CEU in the "webinar / web-based training" category.
> Issued by Simply Cyber LLC.
