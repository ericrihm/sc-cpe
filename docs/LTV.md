# Long-Term Validation (LTV) plan

## Problem

Every cert we ship today is **PAdES-T**: a PAdES-B signature plus an
RFC-3161 timestamp token from an external TSA. That is enough to prove
*when* the signature was made, but PDF verifiers cryptographically verify
the signing certificate chain at *validation time*, not signing time.

Our signing cert is self-signed with a 10-year validity window. The day
it expires, Adobe Reader and every other verifier will flag every cert
we have ever issued as invalid, even though the signatures themselves
are cryptographically fine and the TSA timestamps prove the signatures
predate expiry.

PAdES-LTA fixes this by embedding the full validation material
(certificate chain, CRLs/OCSP responses, and a document timestamp over
all of the above) inside the PDF itself, so a verifier can validate the
cert offline and decades later.

## What we ship in v2

A background re-signing job, run *before* the signing cert expires,
that rewrites each still-valid PDF with:

1. Original signature preserved
2. DSS (Document Security Store) dictionary added with the original
   signing cert, full chain, and CRL/OCSP responses collected at
   re-signing time
3. A fresh document timestamp from our TSA cascade, signed over the
   existing PDF + DSS

The new PDF is re-uploaded to R2 under a new key, `certs.pdf_r2_key` is
updated, `certs.pdf_sha256` refreshed, `supersedes_cert_id` set on a new
row (same `public_token`), and the original retained under `state = 'regenerated'`
for audit chain continuity.

endesive supports the DSS write via `endesive.pdf.cms.sign(..., mode="timestamp")`
on an already-signed document; we will wrap this in a `resign_ltv()`
helper analogous to `sign_pdf_pades()`.

## What we commit to today

1. **Document the trigger condition.** Re-sign all non-revoked certs
   when the signing cert has <18 months of validity remaining. Gives us
   a comfortable window for the re-sign job to run and retry across
   multiple monthly cron cycles if something fails.
2. **Snapshot is in place already.** `certs.signing_cert_sha256` captures
   which signing cert was active at issuance, so we can find every cert
   signed under the expiring chain with a single indexed query.
3. **Supersession is modeled.** `certs.supersedes_cert_id` is a real
   column, and the `certs_user_period_unique` partial unique index
   excludes `state = 'revoked'` — re-signed certs take `state = 'regenerated'`
   and the new cert takes the active slot.
4. **TSA cascade already supports it.** `sign_pdf_pades()` accepts a list
   of TSAs; the re-sign job will use the same primary+fallback chain.

## Before we cross the 18-month line

- Verify endesive's `mode="timestamp"` re-sign path against a sample
  cert signed with our real P12.
- Write `services/certs/resign.py` invoking the same signing material
  loader + R2 uploader as `generate.py`.
- Write a `GET /api/cert/{token}/history` endpoint that exposes the
  `supersedes_cert_id` chain so an auditor can see the re-sign lineage.
- Document the re-sign ceremony in `docs/runbooks/resign.md`: how to run
  it, how to verify output, how to roll back.

## What breaks if we do nothing

When the current signing cert expires:
- Adobe Reader shows every cert as "signature validity is unknown"
- Automated verifiers (pyhanko et al.) fail hard
- Our `/api/verify/{token}` still works (it reads from D1, not from the
  PDF) but auditors won't trust the PDF
- The RFC-3161 timestamp saves us in a dispute, but only if we can still
  produce the original signing cert + chain at the time of the dispute

This is recoverable with a re-sign ceremony up to the point where all of:
1. the expired signing cert
2. the original CRL/OCSP responses from signing time
3. the TSA's signing cert chain

...become unrecoverable. None of that is guaranteed past ~5 years out.
So: **implement the re-sign helper in v2, schedule the ceremony, do not
ship past the 18-month trigger without LTV**.
