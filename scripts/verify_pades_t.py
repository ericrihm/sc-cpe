#!/usr/bin/env python3
"""
verify_pades_t.py — structurally verify that a signed PDF is PAdES-T (or
higher), i.e. its CMS SignedData carries an RFC-3161 signature-timestamp-token
unsigned attribute (OID 1.2.840.113549.1.9.16.2.14).

Usage:
    python scripts/verify_pades_t.py <path/to/cert.pdf>

Exit codes:
    0 — file contains at least one PAdES-T signature.
    1 — file parsed but no signature-timestamp-token found (PAdES-B only).
    2 — file could not be parsed or no CMS /Contents blob located.

This is a *structural* check — it does not fetch TSA CA roots or validate the
timestamp signature chain. For a full cryptographic validation use pyhanko.
The purpose of this script is to guard against regressions in the cert-gen
pipeline: a missing TSA token means the cert will become unverifiable once
the signing cert expires, which is the one failure mode we must not ship.
"""

from __future__ import annotations

import re
import sys

from asn1crypto import cms as asn1_cms

SIG_TS_TOKEN_OID = "1.2.840.113549.1.9.16.2.14"
CONTENTS_RE = re.compile(rb"/Contents\s*<([0-9a-fA-F\s]+)>", re.DOTALL)


def extract_cms_blobs(pdf_bytes: bytes) -> list[bytes]:
    """Extract every /Contents <hex...> blob from a signed PDF."""
    blobs = []
    for m in CONTENTS_RE.finditer(pdf_bytes):
        hex_stripped = bytes(c for c in m.group(1) if c not in (0x20, 0x09, 0x0A, 0x0D))
        # Trim trailing zero padding endesive may add.
        hex_clean = hex_stripped.rstrip(b"0") or b"00"
        if len(hex_clean) % 2:
            hex_clean += b"0"
        try:
            blobs.append(bytes.fromhex(hex_clean.decode("ascii")))
        except ValueError:
            continue
    return blobs


def signer_has_ts_token(signer_info: asn1_cms.SignerInfo) -> bool:
    unsigned_attrs = signer_info["unsigned_attrs"]
    if unsigned_attrs is None or isinstance(unsigned_attrs, asn1_cms.Void):
        return False
    for attr in unsigned_attrs:
        if attr["type"].dotted == SIG_TS_TOKEN_OID:
            return True
    return False


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: verify_pades_t.py <pdf>", file=sys.stderr)
        return 2
    with open(argv[1], "rb") as fh:
        pdf = fh.read()

    blobs = extract_cms_blobs(pdf)
    if not blobs:
        print(f"{argv[1]}: no /Contents CMS blob found", file=sys.stderr)
        return 2

    pades_t_count = 0
    signers_total = 0
    for blob in blobs:
        try:
            ci = asn1_cms.ContentInfo.load(blob)
            signed_data = ci["content"]
            for si in signed_data["signer_infos"]:
                signers_total += 1
                if signer_has_ts_token(si):
                    pades_t_count += 1
        except Exception as e:  # noqa: BLE001
            print(f"{argv[1]}: parse error: {e}", file=sys.stderr)
            return 2

    if signers_total == 0:
        print(f"{argv[1]}: no SignerInfo found in CMS", file=sys.stderr)
        return 2
    if pades_t_count == 0:
        print(
            f"{argv[1]}: PAdES-B only — no RFC-3161 signature-timestamp-token "
            f"on any of {signers_total} signer(s)",
            file=sys.stderr,
        )
        return 1
    print(
        f"{argv[1]}: PAdES-T OK "
        f"({pades_t_count}/{signers_total} signer(s) carry signatureTimeStampToken)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
