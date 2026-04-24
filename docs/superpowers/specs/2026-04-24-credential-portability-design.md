# Credential Portability — Design Spec

**Date:** 2026-04-24
**Author:** Eric Rihm
**Status:** Approved

## Overview

Add machine-readable credential export (Open Badges v3), LinkedIn one-click profile addition, and per-certification-body CPE submission guides to SC-CPE. These three features ship together as a "credential portability" package that makes SC-CPE certificates useful beyond PDF download. Also includes HSTS preload directive (Category C cleanup).

No schema changes required — all cert data already exists in D1.

## 1. OBv3 Credential Endpoint

### `GET /api/credential/{cert_token}.json`

Public endpoint. Same lookup pattern as `/api/verify/{token}` — finds the cert row by `verify_token`, returns 404 if not found or cert is revoked.

**Response:** OBv3 JSON-LD document:

```json
{
  "@context": [
    "https://www.w3.org/ns/credentials/v2",
    "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json"
  ],
  "id": "https://sc-cpe-web.pages.dev/api/credential/<verify_token>.json",
  "type": ["VerifiableCredential", "OpenBadgeCredential"],
  "issuer": {
    "id": "https://sc-cpe-web.pages.dev",
    "type": ["Profile"],
    "name": "Simply Cyber",
    "url": "https://www.youtube.com/@SimplyCyber"
  },
  "validFrom": "<cert.issued_at ISO>",
  "name": "Simply Cyber CPE Certificate — <period_display>",
  "credentialSubject": {
    "type": ["AchievementSubject"],
    "achievement": {
      "id": "https://sc-cpe-web.pages.dev/achievements/cpe-attendance",
      "type": ["Achievement"],
      "name": "CPE/CEU Attendance Credit",
      "description": "Continuing professional education credit earned by attending the Simply Cyber Daily Threat Briefing livestream.",
      "criteria": {
        "narrative": "Attended <sessions_count> Daily Threat Briefing sessions during <period_display>, verified via YouTube live chat code matching."
      }
    }
  },
  "proof": {
    "type": "DataIntegrityProof",
    "cryptosuite": "eddsa-rdfc-2022",
    "verificationMethod": "https://sc-cpe-web.pages.dev/.well-known/jwks.json#ob-signing-key",
    "proofPurpose": "assertionMethod",
    "created": "<cert.issued_at ISO>",
    "proofValue": "<multibase-encoded-Ed25519-signature>"
  }
}
```

**Signing flow:**
1. Read `OB_SIGNING_KEY` secret (base64-encoded Ed25519 private key, 32 bytes)
2. Import via `crypto.subtle.importKey("raw", ..., "Ed25519", false, ["sign"])`
3. Canonicalize the credential (without `proof`) using JSON canonicalization (JCS / RFC 8785)
4. Sign the canonical bytes with Ed25519
5. Encode signature as multibase (`z` prefix + base58btc)
6. Attach `proof` object to credential

**Edge cases:**
- Revoked certs: return `404` (same as verify endpoint)
- Certs in `state='pending'` or `state='regenerated'`: return `404`
- Only `state='generated'` or `state='sent'` certs are exportable

**Rate limiting:** Same as verify endpoint — public, read-only, low abuse potential. Use existing `rateLimit()` with 120 requests/window.

**Audit logging:** Log `credential_exported` action with cert_id (same pattern as `cert_downloaded`).

## 2. JWKS Endpoint

### `GET /.well-known/jwks.json`

Returns the Ed25519 public key in JWK format, derived from the `OB_SIGNING_KEY` secret at request time.

```json
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "<base64url-encoded-public-key>",
      "kid": "ob-signing-key",
      "use": "sig",
      "alg": "EdDSA"
    }
  ]
}
```

**Key derivation:** Ed25519 private key → public key via `crypto.subtle.exportKey("jwk", publicKey)`. Import the 32-byte secret as private key, then export public component.

**Cache:** Set `Cache-Control: public, max-age=86400` — key rotation is rare.

**Implementation:** `pages/functions/.well-known/jwks.js` as a Pages Function. The `.well-known` directory works with Cloudflare Pages Functions routing.

## 3. LinkedIn "Add to Profile" Integration

### Deep-link URL format

```
https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME&name={certName}&issueYear={year}&issueMonth={month}&certId={certId}&certUrl={verifyUrl}
```

**Parameters built from cert data:**
- `name`: `Simply Cyber CPE Certificate — {period_display}`
- `issueYear`: extracted from `issued_at`
- `issueMonth`: extracted from `issued_at`
- `certId`: cert `id` or `verify_token`
- `certUrl`: `{origin}/verify/{verify_token}`

No `organizationId` — Simply Cyber's LinkedIn company page ID would need manual lookup; omitting it still works (user confirms the org manually).

### UI placement

**dashboard.html** — Each cert card in the certificate list gets two new icon buttons next to the existing download button:
- LinkedIn icon (opens deep-link in new tab)
- Open Badge icon (downloads `.json` credential)

**badge.html** — Add LinkedIn button to the public badge page alongside existing share options.

### Implementation

Buttons are constructed client-side in `dashboard.js` from the cert data already loaded via `/api/me/{token}`. No new API calls needed.

## 4. CPE Submission Guide Page

### `cpe-guide.html`

New public page with three tabbed sections for CompTIA, ISC2, and ISACA. Each tab contains:

1. **Portal link** — direct URL to the certification body's CPE submission portal
2. **Step-by-step instructions** — numbered list of exactly what to click/fill
3. **Pre-filled field values** — pulled from URL query params, with "Copy" buttons:
   - Activity name: "Simply Cyber Daily Threat Briefing"
   - Provider: "Simply Cyber LLC"
   - Date range: from cert period
   - CPE/CEU count: from cert data
   - Evidence: link to download PAdES-T PDF
   - Verification URL: link to public verify page
4. **"Download PDF Evidence" button** — links to `/api/download/{download_token}`

### URL params

```
cpe-guide.html?name=April+2026&hours=10&sessions=20&certUrl=...&downloadUrl=...
```

Dashboard cert cards link to this page with params pre-filled.

### Styling

Follows existing SC-CPE page patterns: navy/teal color scheme, `cpe-guide.css` extracted (CSP compliance), responsive. Tab switching via vanilla JS in `cpe-guide.js`.

## 5. HSTS Preload Directive

### `_middleware.js` change

Current:
```
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

New:
```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

Doubles max-age to 2 years (preload requirement) and adds `preload` directive. Actual hstspreload.org submission deferred until `cpe.simplycyber.io` DNS is wired.

## 6. Ed25519 Key Generation

One-time setup step (not automated in code). Operator runs:

```bash
node -e "
const crypto = require('crypto');
const kp = crypto.generateKeyPairSync('ed25519');
const der = kp.privateKey.export({ type: 'pkcs8', format: 'der' });
console.log(der.slice(-32).toString('base64'));
"
```

Then stores result as `OB_SIGNING_KEY` Pages secret:
```bash
cd pages && wrangler pages secret put OB_SIGNING_KEY
```

This is documented in the RUNBOOK, not automated in code.

## Files

| Action | Path | Purpose |
|--------|------|---------|
| Create | `pages/functions/api/credential/[token].js` | OBv3 JSON-LD endpoint |
| Create | `pages/functions/.well-known/jwks.js` | JWKS public key endpoint |
| Create | `pages/cpe-guide.html` | CPE submission guide page |
| Create | `pages/cpe-guide.js` | Guide page tab logic + copy buttons |
| Create | `pages/cpe-guide.css` | Guide page styles |
| Modify | `pages/dashboard.html` | Add LinkedIn + OB buttons to cert cards |
| Modify | `pages/dashboard.js` | Build LinkedIn deep-link + OB download URLs |
| Modify | `pages/functions/_middleware.js` | HSTS preload directive |
| Modify | `pages/functions/_lib.js` | Add `buildObCredential()` + `signObCredential()` helpers |
| Modify | `docs/RUNBOOK.md` | Add Ed25519 key generation + rotation procedure |

## Non-goals

- Multi-provider CPE aggregation (separate future project)
- OBv3 revocation status list (certs are already revocable via CRL; OBv3 `credentialStatus` can be added later)
- Automated cert-body API submission (no APIs exist; guide page is the right approach)
- LinkedIn `organizationId` lookup (omitting works; user confirms manually)
