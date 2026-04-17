# Design Document

SC-CPE is a system that automatically issues cryptographically verifiable
CPE/CEU certificates to attendees of the Simply Cyber Daily Threat Briefing
YouTube livestream. This document explains the architectural decisions and
the reasoning behind them.

## Problem Statement

Continuing Professional Education tracking across the cybersecurity industry
relies on self-attestation, paper certificates, and honor-system spreadsheets.
There is no standard mechanism for an auditor to independently verify that a
claimed training event actually occurred, that the claimant was present, or
that the certificate they hold is the one the issuer produced. This creates
fraud risk for certification bodies, administrative burden for practitioners,
and zero auditability for everyone.

## Design Principles

Four principles drive every architectural decision in this system.

**Trust-minimized.** Cryptographic proof replaces trust wherever possible.
Attendance is proved by a code exchange in a public chat stream. Certificate
authenticity is proved by a PAdES-T digital signature with an RFC-3161
timestamp. Audit integrity is proved by a hash chain. No step requires
trusting the operator's word alone.

**Append-only audit.** The audit log is a SHA-256 hash-chained table with a
`UNIQUE INDEX` on `prev_hash`. Rows are never updated or deleted. A fork
(two writers claiming the same predecessor) fails at insert time. The full
chain is replayable offline by anyone with read access to the database.

**Offline verifiability.** A relying party (auditor, certification body,
employer) can verify a certificate without contacting the issuer. The PDF
carries a self-contained digital signature. The verify portal recomputes
the SHA-256 client-side. The audit chain verifier runs against a database
export. No phone call, no email, no API key required.

**Fail-closed.** Every safety gate defaults to deny. The rate limiter returns
503 if its KV binding is missing rather than silently disabling itself.
The poller refuses to credit attendance when `actual_start_at` parses to
NaN rather than crediting everyone. The cert signer refuses to ship an
unstamped PDF when the TSA is unreachable. Admin token comparison uses
constant-time HMAC digests to avoid timing oracles.

## Architecture Decisions

### Why PAdES-T signed PDFs (not just a database record)

A database record proves the issuer says a cert exists. A signed PDF proves
the cert existed at a specific point in time, was produced by a specific
key, and has not been modified since. The distinction matters because:

- The issuer could be compromised, shut down, or change their records.
- Certification bodies accept PDF documents as evidence; they do not
  accept API responses from unknown third parties.
- PAdES-T embeds an RFC-3161 timestamp token as an unsigned CMS attribute
  on the SignerInfo. This means the signature remains valid after the
  signing certificate expires, because the timestamp authority attests
  that the signature existed before expiry. A bare CMS signature without
  a timestamp becomes unverifiable the moment the cert's validity period
  ends.

The signing pipeline: WeasyPrint renders HTML to PDF, then `endesive`
applies a PAdES signature with a pre-allocated 16 KiB `/Contents` slot.
The TSA cascade tries the primary endpoint, then DigiCert and SSL.com as
fallbacks. If all TSAs fail and `tsa_required` is true (the production
default), the cert is not issued. The signing certificate's SHA-256
fingerprint is printed on the face of every PDF so a verifier can confirm
the PDF reader's reported signer matches the issuer's published key.

### Why hash-chained audit log (not just timestamps)

Timestamps prove when something was recorded. A hash chain proves that
nothing was inserted, removed, or reordered after the fact.

Each audit row stores `prev_hash`, the SHA-256 of the canonical
serialization of the preceding row. The canonical form is a JSON array
(not object) to eliminate cross-runtime key-ordering ambiguity:

```
[id, actor_type, actor_id, action, entity_type, entity_id,
 before_json, after_json, ip_hash, user_agent, ts, prev_hash]
```

This identical serialization exists in three codebases (JavaScript Pages
functions, JavaScript Workers, Python cert generator) and a parity test
guards against drift.

A `UNIQUE INDEX` on `prev_hash WHERE prev_hash IS NOT NULL` serializes
concurrent writers. If two processes read the same chain tip and both
attempt to insert with the same `prev_hash`, exactly one succeeds and the
other retries with the new tip. A separate partial unique index on the
genesis row (`WHERE prev_hash IS NULL`) prevents multiple genesis rows.
The retry loop caps at 5 attempts with jittered backoff.

The result: an operator with full database access cannot silently delete an
attendance record or revoke a cert without leaving a gap in the hash chain
that `verify_audit_chain.py` will detect.

### Why RFC-3161 timestamps (not just server time)

Server time proves nothing to a third party. The server controls its own
clock. An RFC-3161 timestamp is a signed assertion from an independent
Timestamp Authority that a specific hash existed at a specific time.

In PAdES-T, the timestamp token is embedded inside the CMS signature as
an unsigned attribute. This creates a three-party proof: the document
content (hashed), the signer's key (CMS signature), and the TSA's
attestation (countersignature on the signature). Any party can verify
all three without cooperation from the other two.

The system cascades through multiple TSAs (freetsa.org, DigiCert,
SSL.com) to tolerate individual outages. After signing, a byte-level
check confirms the OID for `id-aa-signatureTimeStampToken`
(1.2.840.113549.1.9.16.2.14) is present in the output PDF. If it is
not, the cert is not shipped.

### Why Cloudflare Workers (edge compute, per-minute cron, D1 SQLite)

The system needs per-minute polling during a 3-hour weekday window,
low-latency API responses, durable storage, and near-zero ops burden for
a single operator. Cloudflare Workers provide:

- **Cron triggers** with per-minute granularity for the chat poller.
- **D1** (SQLite over HTTP) as the single source of truth, with automatic
  replication and zero connection management.
- **R2** for object storage (raw chat JSONL with 7-day TTL, signed PDFs
  with indefinite retention).
- **Pages Functions** as the web API layer, co-located with D1 and R2
  via bindings rather than network calls.
- **KV** for ephemeral rate-limiting state and kill switches.

The alternative was a VPS with cron + PostgreSQL + S3. The Workers
approach eliminates server patching, process supervision, TLS renewal,
and capacity planning. The tradeoff is D1's single-region-write
constraint, which is acceptable for a system with low write volume
(~200 attendance records/day at scale) and no cross-region consistency
requirements.

### Why bearer tokens over sessions (CSRF immunity for admin endpoints)

Admin endpoints use `Authorization: Bearer <token>` headers. Browsers do
not automatically attach `Authorization` headers to cross-origin requests,
so admin endpoints are CSRF-immune by construction. No CSRF tokens, no
double-submit cookies, no SameSite gymnastics.

User dashboard endpoints use a different pattern: the dashboard token sits
in the URL path (`/api/me/{token}/...`). This is inherently CSRF-sensitive
because a third party who knows the URL can forge cross-origin POSTs. These
endpoints enforce `Origin` header validation via `isSameOrigin()`, rejecting
requests where the `Origin` is null or does not match the serving host.

The admin token comparison itself uses HMAC-SHA256 with a per-request random
key to achieve constant-time comparison without leaking the token's length.
An earlier implementation returned early on length mismatch, which would have
been a length-enumeration oracle.

### Why verification codes in YouTube chat (proof of live attendance)

The system needs to prove that a specific person was watching a specific
livestream at a specific time. The proof mechanism:

1. User registers and receives a unique code (`SC-CPE{XXXX-XXXX}`) via email.
2. User posts the code in YouTube live chat during the broadcast.
3. The poller matches the code, binds the user's YouTube channel, and
   credits attendance.

This establishes a chain: email ownership (registration) links to YouTube
channel ownership (code posted from that channel) links to live presence
(message timestamp falls within the broadcast window). The code is single-use
for channel binding and expires after 72 hours.

The poller enforces a time gate: messages with `publishedAt` before
`actual_start_at - pre_start_grace_min` are rejected. This prevents a user
from dropping their code in pre-stream chat and walking away. Rejected
attempts are logged to the audit chain and surfaced on the user's dashboard
so they know to retry.

### Why contested-code detection (anti-race-attack defense)

Verification codes posted in YouTube live chat are visible to every viewer.
An attacker tailing the chat can copy a fresh code and post it from their
own channel before the legitimate user does. Without mitigation, the first
poll wins and the attacker's channel gets bound to the victim's account.

Defense: before processing any code match, the poller scans the entire
message batch for codes posted by two or more distinct channels. If a code
appears from multiple channels in the same batch, neither channel is bound.
The code is burned (cleared from the user record) so the attacker cannot
replay it on a future poll. The user must request a fresh code via the
dashboard. The detection is a pure function (`detectContestedCodes`) with
dedicated test coverage.

This does not defend against an attacker who posts the code in a different
poll cycle than the legitimate user. That attack requires the attacker to
be faster than the poller's per-minute cycle, which is a narrow window.
The 72-hour code expiry and single-use channel binding further limit the
attack surface. See the Trust Model section for honest limitations.

## Trust Model

### What the system proves

- **Email ownership.** The registrant controls the email address they
  signed up with (verified by dashboard-token delivery).
- **YouTube channel binding.** The registrant's YouTube channel posted a
  valid verification code during a live broadcast window.
- **Temporal attendance.** The qualifying chat message's `publishedAt`
  timestamp (set by YouTube, not by us) falls within the broadcast window.
- **Certificate authenticity.** The PDF was signed by a specific key at a
  specific time, and has not been modified since (PAdES-T + RFC-3161).
- **Audit completeness.** The hash chain has no gaps, insertions, or
  reorderings (replayable by any party with database read access).

### What the system does not prove

- **Identity.** There is no KYC or government-ID verification. The system
  attests that a channel-holder who claimed a given legal name posted
  qualifying messages. It does not attest that the channel-holder is who
  they say they are.
- **Continuous viewing.** Attendance is a binary signal. One qualifying
  chat message during the live window earns credit for the entire session.
  The system cannot distinguish someone who watched the full hour from
  someone who posted a code and left.
- **Content comprehension.** The system proves presence, not learning. This
  is consistent with how all CPE self-study and webinar credits work across
  ISC2, ISACA, and CompTIA.
- **Cross-cycle race attacks.** If an attacker posts a stolen code in a
  different poll cycle than the legitimate user, contested-code detection
  will not catch it. The per-minute polling interval and 72-hour code expiry
  bound this risk but do not eliminate it.
- **YouTube API integrity.** The system trusts YouTube's `publishedAt`
  timestamps and `authorDetails.channelId` values. A compromise of the
  YouTube Data API would undermine attendance proofs.

### Operator trust boundary

The system operator has access to the D1 database, R2 storage, and signing
key. A malicious operator could issue fraudulent certificates. The hash-chained
audit log makes this detectable after the fact (the fraudulent issuance would
appear in the chain, or the chain would have a gap), but does not prevent it.
The signing key password and PKCS#12 bundle are stored as GitHub Actions
secrets and Cloudflare environment variables, never in the repository.

## Data Flow

```
                                         YouTube Data API v3
                                                |
                                      liveChatMessages.list
                                                |
                                                v
 +----------+    email     +----------+    +----------+    D1     +--------+
 |          |  (code in    |          |    |  Poller  |---------->|        |
 |   User   |  dashboard   |   User   |    |  Worker  |  credits  |   D1   |
 | Register |  link)       |  Posts   |    | (1/min)  |  attend.  | SQLite |
 |          |<-------------|  Code in |    +----------+           |        |
 +----------+              |  Chat    |         |                 +--------+
       |                   +----------+    R2 (raw JSONL)              |
       |                                                               |
       |                                                     reads attendance
       |                                                               |
       |                                                               v
       |                                                    +-------------------+
       |                                                    |   Cert Generator  |
       |                                                    |   (Python, GHA)   |
       |                                                    +-------------------+
       |                                                      |       |       |
       |                                                 WeasyPrint  endesive  RFC-3161
       |                                                 (render)   (sign)    TSA
       |                                                      |       |       |
       |                                                      v       v       v
       |                                                    +-------------------+
       |              email (download link)                  |   Signed PDF     |
       |<---------------------------------------------------|   -> R2 upload   |
       |                                                    |   -> D1 record   |
       |                                                    |   -> email queue  |
       |                                                    +-------------------+
       |
       v
 +------------------+
 |  Verify Portal   |    Anyone can verify:
 |  /verify.html    |    1. PDF signature (any PAdES reader)
 |                  |    2. SHA-256 match (client-side recompute)
 | SHA-256 computed |    3. Revocation status (public CRL)
 | in the browser   |    4. Audit chain (offline replay)
 +------------------+
```

```
Lifecycle of an attendance credit:

  register ──> email with code ──> post code in live chat
                                          |
                              poller matches code
                              binds YouTube channel
                              credits 0.5 CPE
                                          |
                              ┌───────────┴───────────┐
                              v                       v
                        per-session cert         monthly bundle
                        (on demand, ~2h)        (1st of month)
                              |                       |
                              v                       v
                        PAdES-T sign ──────── PAdES-T sign
                              |                       |
                              v                       v
                        R2 upload ──────────── R2 upload
                              |                       |
                              v                       v
                        email delivery ─────── email delivery
                              |                       |
                              v                       v
                        verifiable by anyone, offline, indefinitely
```

```
Audit chain structure:

  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
  │  Genesis     │     │  Row N       │     │  Row N+1     │
  │  prev_hash:  │     │  prev_hash:  │     │  prev_hash:  │
  │    NULL      │──>  │  sha256(N-1) │──>  │  sha256(N)   │
  │              │     │              │     │              │
  │  UNIQUE idx  │     │  UNIQUE idx  │     │  UNIQUE idx  │
  │  on genesis  │     │  on prev_hash│     │  on prev_hash│
  └──────────────┘     └──────────────┘     └──────────────┘

  Invariant: UNIQUE INDEX on prev_hash means two rows cannot
  claim the same predecessor. Chain forks fail at INSERT time.
  Deletions leave a gap detectable by verify_audit_chain.py.
```
