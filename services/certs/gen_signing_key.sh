#!/usr/bin/env bash
# gen_signing_key.sh
#
# One-time (or rotation-time) generator for the SC-CPE PDF signing key.
# Produces a self-signed PKCS#12 bundle that endesive can load to PAdES-sign
# issued certificates.
#
# Usage:
#   chmod +x gen_signing_key.sh
#   ./gen_signing_key.sh
#
# Then upload to GitHub:
#   gh secret set PDF_SIGNING_KEY_P12_BASE64 < sc-cpe-signing.p12.b64
#   gh secret set PDF_SIGNING_KEY_PASSWORD       # enter the password you set below
#
# --- Key rotation notes ----------------------------------------------------
# Re-running this script creates a BRAND NEW keypair and a BRAND NEW cert
# fingerprint. Important implications:
#
#  * Previously issued PDFs were signed by the OLD private key. Their embedded
#    signatures still validate forever against the OLD public cert, provided
#    the verification portal retains the old public cert in its trust list.
#    The portal should therefore keep a historical list of trusted public
#    certs keyed by SHA-256 fingerprint (which we also snapshot into certs.signing_cert_sha256).
#
#  * The `signing_cert_sha256` column on `certs` is a point-in-time record of
#    which cert signed which PDF. Do NOT mutate old rows when rotating.
#
#  * After rotation, export the new public cert (sc-cpe-signing.crt) and add
#    its SHA-256 fingerprint to the verification portal's trusted set before
#    the next scheduled run, or new certs will show as "unknown signer" to
#    auditors.
#
#  * The .key and .p12 files MUST NOT be committed. .gitignore in this
#    directory already excludes them.
# ---------------------------------------------------------------------------

set -euo pipefail

OUT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$OUT_DIR"

# Change this for production; the workflow reads the password from the
# PDF_SIGNING_KEY_PASSWORD secret and passes it to endesive at sign time.
P12_PASSWORD="${P12_PASSWORD:-CHANGE_ME}"

echo "[gen_signing_key] Generating RSA 4096 keypair + self-signed cert (10y)..."
openssl req -x509 -newkey rsa:4096 \
  -keyout sc-cpe-signing.key \
  -out sc-cpe-signing.crt \
  -days 3650 -nodes \
  -subj "/CN=Simply Cyber LLC CPE Issuer/O=Simply Cyber LLC/C=US"

echo "[gen_signing_key] Bundling into PKCS#12..."
openssl pkcs12 -export \
  -out sc-cpe-signing.p12 \
  -inkey sc-cpe-signing.key \
  -in sc-cpe-signing.crt \
  -passout "pass:${P12_PASSWORD}"

echo "[gen_signing_key] Writing base64 (no newlines) ..."
base64 sc-cpe-signing.p12 | tr -d '\n' > sc-cpe-signing.p12.b64

FPR=$(openssl x509 -in sc-cpe-signing.crt -noout -fingerprint -sha256 | \
      sed 's/^.*=//' | tr -d ':' | tr 'A-Z' 'a-z')

echo ""
echo "== Done =="
echo "Files written in: ${OUT_DIR}"
echo "  sc-cpe-signing.key       (PRIVATE KEY — do NOT commit)"
echo "  sc-cpe-signing.crt       (public cert — ok to share with verify portal)"
echo "  sc-cpe-signing.p12       (PKCS#12 bundle — do NOT commit)"
echo "  sc-cpe-signing.p12.b64   (base64 of p12 for GitHub secret — do NOT commit)"
echo ""
echo "Signing cert SHA-256 fingerprint (add to verify-portal trusted list):"
echo "  ${FPR}"
echo ""
echo "Next steps:"
echo "  gh secret set PDF_SIGNING_KEY_P12_BASE64 < sc-cpe-signing.p12.b64"
echo "  gh secret set PDF_SIGNING_KEY_PASSWORD     # type the password you used"
