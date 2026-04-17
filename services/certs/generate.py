#!/usr/bin/env python3
"""
SC-CPE monthly certificate generator.

Runs in GitHub Actions on the 1st (and 2nd/3rd as idempotent retries) of each
month. For each active user with >0 CPE earned in the prior calendar month,
this script:

  1. Generates a ULID cert_id and a 64-hex-char public_token.
  2. Renders an HTML certificate from template.html via Jinja2.
  3. Converts HTML -> PDF via WeasyPrint.
  4. PAdES-signs the PDF via endesive using a PKCS#12 bundle.
  5. Uploads the signed PDF to R2 (bucket sc-cpe-certs, key certs/<uid>/<cid>.pdf).
  6. HEADs the uploaded object to verify it exists at the expected size.
  7. Builds a durable download URL (cpe.simplycyber.io/api/download/{token})
     that the Pages Function resolves against R2 on demand. Replaces the
     old 30-day presigned URL, which S3 rejects as >604800s.
  8. Inserts a row into certs (state='generated').
  9. Queues a row into email_outbox (idempotency_key=cert_id) and sends via Resend.
 10. On successful send: marks email_outbox.state='sent' and certs.state='delivered'.
 11. Writes an audit_log entry.

Idempotency guard: before generating anything we check the
`UNIQUE(user_id, period_yyyymm) WHERE state != 'revoked'` index by
SELECTing from certs. Already-issued users are skipped cleanly.
Per-user errors are caught; one failure does not abort the batch.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import io
import json
import os
import secrets
import sys
import time
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Iterable

import boto3
import requests
from botocore.client import Config as BotoConfig
from dateutil.relativedelta import relativedelta
from endesive.pdf import cms as endesive_cms
from jinja2 import Environment, FileSystemLoader, select_autoescape
from weasyprint import HTML

# ---------------------------------------------------------------------------
# Structured JSON logging
# ---------------------------------------------------------------------------


def log(level: str, event: str, **fields: Any) -> None:
    """Emit a single JSON log line to stdout."""
    rec: dict[str, Any] = {
        "ts": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "level": level,
        "event": event,
    }
    rec.update(fields)
    try:
        print(json.dumps(rec, default=str), flush=True)
    except Exception:  # pragma: no cover - logging must never raise
        print(f"{level} {event} {fields}", flush=True)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def new_ulid() -> str:
    """Generate a 26-char Crockford Base32 ULID.

    Layout: 48-bit timestamp (ms since epoch) + 80-bit randomness.
    """
    ts_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    rand = int.from_bytes(secrets.token_bytes(10), "big")
    n = (ts_ms << 80) | rand  # 128 bits total

    out = []
    for _ in range(26):
        out.append(CROCKFORD[n & 0x1F])
        n >>= 5
    return "".join(reversed(out))


def new_public_token() -> str:
    """64 hex chars = 32 random bytes."""
    return secrets.token_hex(32)


def now_iso_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def require_env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        log("error", "missing_env", name=name)
        raise RuntimeError(f"required env var {name} is not set")
    return v


# ---------------------------------------------------------------------------
# D1 HTTP client
# ---------------------------------------------------------------------------


class D1Error(RuntimeError):
    pass


class D1Client:
    """Minimal D1 HTTP API client.

    POST https://api.cloudflare.com/client/v4/accounts/{acct}/d1/database/{db}/query
    Body: {"sql": "...", "params": [...]}
    Response: {"success": bool, "errors": [...], "result": [{"results": [...], ...}], ...}
    """

    def __init__(self, account_id: str, database_id: str, api_token: str):
        self.url = (
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
            f"/d1/database/{database_id}/query"
        )
        self.headers = {
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        }
        self._sess = requests.Session()

    def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        body = {"sql": sql, "params": params or []}
        resp = self._sess.post(self.url, headers=self.headers, json=body, timeout=30)
        try:
            payload = resp.json()
        except ValueError as e:
            raise D1Error(f"D1 non-JSON response ({resp.status_code}): {resp.text[:500]}") from e

        if resp.status_code >= 400 or not payload.get("success"):
            raise D1Error(
                f"D1 query failed status={resp.status_code} "
                f"errors={payload.get('errors')} sql={sql[:200]}"
            )
        result = payload.get("result") or []
        if not result:
            return []
        # result is a list of statement results; we only submit one statement here.
        return result[0].get("results") or []

    def execute(self, sql: str, params: list[Any] | None = None) -> None:
        """For INSERT/UPDATE; we don't need rows back."""
        self.query(sql, params)


# ---------------------------------------------------------------------------
# Audit hash chain
# ---------------------------------------------------------------------------
# Canonical serialisation for audit_log rows — MUST match
# pages/functions/_lib.js, workers/{poller,purge}/src/index.js, and
# scripts/verify_audit_chain.py byte-for-byte. Any divergence breaks the chain.
# Array form (vs. object) sidesteps cross-runtime key-ordering ambiguity.


_AUDIT_FIELDS = (
    "id", "actor_type", "actor_id", "action",
    "entity_type", "entity_id",
    "before_json", "after_json",
    "ip_hash", "user_agent",
    "ts", "prev_hash",
)


def canonical_audit_row(r: dict[str, Any]) -> str:
    return json.dumps(
        [r.get(k) for k in _AUDIT_FIELDS],
        separators=(",", ":"),
        ensure_ascii=False,
    )


def insert_chained_audit(
    d1: "D1Client",
    *,
    actor_type: str,
    actor_id: str | None,
    action: str,
    entity_type: str,
    entity_id: str,
    before_json: str | None,
    after_json: str | None,
    ip_hash: str | None = None,
    user_agent: str | None = None,
) -> str:
    """Insert a hash-chained audit_log row. Retries on UNIQUE contention."""
    max_attempts = 5
    last_err: Exception | None = None
    for _ in range(max_attempts):
        tip_rows = d1.query(
            f"SELECT {', '.join(_AUDIT_FIELDS)} FROM audit_log "
            "ORDER BY ts DESC, id DESC LIMIT 1",
            [],
        )
        prev_hash: str | None
        if tip_rows:
            prev_hash = hashlib.sha256(
                canonical_audit_row(tip_rows[0]).encode("utf-8")
            ).hexdigest()
        else:
            prev_hash = None

        new_id = new_ulid()
        ts = now_iso_utc()
        try:
            d1.execute(
                """
                INSERT INTO audit_log
                  (id, actor_type, actor_id, action, entity_type, entity_id,
                   before_json, after_json, ip_hash, user_agent, ts, prev_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    new_id, actor_type, actor_id, action, entity_type, entity_id,
                    before_json, after_json, ip_hash, user_agent, ts, prev_hash,
                ],
            )
            return new_id
        except D1Error as e:
            last_err = e
            if "UNIQUE" not in str(e).upper():
                raise
            time.sleep(0.01 + secrets.randbelow(40) / 1000.0)
    raise RuntimeError(f"audit chain contention: {max_attempts} attempts failed: {last_err}")


# ---------------------------------------------------------------------------
# Config (pulled from env once)
# ---------------------------------------------------------------------------


@dataclass
class Config:
    cf_account_id: str
    cf_api_token: str
    d1_database_id: str

    r2_access_key_id: str
    r2_secret_access_key: str
    r2_endpoint_url: str
    cert_r2_bucket: str

    p12_b64: str
    p12_password: str

    resend_api_key: str
    from_email: str

    issuer_name: str
    verify_base_url: str
    download_base_url: str

    tsa_url: str
    tsa_urls_fallback: list[str]
    tsa_required: bool

    period_override: str | None = None
    # Bounded concurrency for the per-user issue loop. Each issue_for_user()
    # blocks on (a) the TSA network round-trip during PAdES signing and
    # (b) R2/D1/Resend HTTP calls — all I/O. 4 workers cuts wall-time
    # roughly by ~3.5x on a 50-user month without overwhelming any
    # single remote. Override via CERT_ISSUE_WORKERS env.
    issue_workers: int = 4

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            cf_account_id=require_env("CLOUDFLARE_ACCOUNT_ID"),
            cf_api_token=require_env("CLOUDFLARE_API_TOKEN"),
            d1_database_id=require_env("D1_DATABASE_ID"),
            r2_access_key_id=require_env("R2_ACCESS_KEY_ID"),
            r2_secret_access_key=require_env("R2_SECRET_ACCESS_KEY"),
            r2_endpoint_url=require_env("R2_ENDPOINT_URL"),
            cert_r2_bucket=os.environ.get("CERT_R2_BUCKET", "sc-cpe-certs"),
            p12_b64=require_env("PDF_SIGNING_KEY_P12_BASE64"),
            p12_password=require_env("PDF_SIGNING_KEY_PASSWORD"),
            resend_api_key=require_env("RESEND_API_KEY"),
            from_email=os.environ.get("FROM_EMAIL", "Simply Cyber CPE <certs@signalplane.co>"),
            issuer_name=os.environ.get("ISSUER_NAME", "Simply Cyber LLC"),
            # Default to the Pages production alias because the apex
            # cpe.simplycyber.io is not yet pointed at the project — the
            # workflow can override both via env once DNS is wired.
            verify_base_url=os.environ.get(
                "VERIFY_BASE_URL", "https://sc-cpe-web.pages.dev/verify.html"
            ),
            # Durable download endpoint (Pages function streams from R2 binding).
            # Email links point here so they never expire — S3 presigned URLs
            # cap at 604800s / 7 days which is too short for monthly certs.
            download_base_url=os.environ.get(
                "DOWNLOAD_BASE_URL", "https://sc-cpe-web.pages.dev/api/download"
            ),
            tsa_url=os.environ.get("TSA_URL", "https://freetsa.org/tsr"),
            # Comma-separated list of RFC-3161 fallback TSAs. Tried in order
            # if the primary fails or returns no token. DigiCert and SSL.com
            # are free, public RFC-3161 TSAs without rate limits for low
            # volume; adjust if either changes their policy.
            tsa_urls_fallback=[
                u.strip() for u in os.environ.get(
                    "TSA_URLS_FALLBACK",
                    "http://timestamp.digicert.com,http://ts.ssl.com",
                ).split(",") if u.strip()
            ],
            tsa_required=(os.environ.get("TSA_REQUIRED", "1").strip().lower()
                          not in ("0", "false", "no", "")),
            period_override=(os.environ.get("PERIOD_YYYYMM") or "").strip() or None,
            issue_workers=max(1, min(16, int(os.environ.get("CERT_ISSUE_WORKERS", "4")))),
        )


# ---------------------------------------------------------------------------
# Period resolution
# ---------------------------------------------------------------------------


def resolve_period(cfg: Config) -> tuple[str, dt.date, dt.date, str]:
    """Return (period_yyyymm, period_start, period_end, period_display)."""
    if cfg.period_override:
        if len(cfg.period_override) != 6 or not cfg.period_override.isdigit():
            raise ValueError(f"PERIOD_YYYYMM must be YYYYMM, got {cfg.period_override!r}")
        yyyy = int(cfg.period_override[:4])
        mm = int(cfg.period_override[4:])
        first = dt.date(yyyy, mm, 1)
    else:
        today_utc = dt.datetime.now(dt.timezone.utc).date()
        first_of_this_month = today_utc.replace(day=1)
        first = first_of_this_month - relativedelta(months=1)

    next_first = first + relativedelta(months=1)
    last = next_first - dt.timedelta(days=1)
    period_yyyymm = f"{first.year:04d}{first.month:02d}"
    display = first.strftime("%B %Y")
    return period_yyyymm, first, last, display


# ---------------------------------------------------------------------------
# Signing key loading
# ---------------------------------------------------------------------------


@dataclass
class SigningMaterial:
    p12_path: str
    p12_password: str
    cert_der_sha256: str  # hex
    cert_pem: str  # for debugging / portal bootstrap


def load_signing_material(cfg: Config) -> SigningMaterial:
    """Decode the PKCS#12 base64 to a temp file; extract the public cert
    SHA-256 fingerprint (DER-form) so we can snapshot it on every issued cert.
    """
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.hazmat.primitives import hashes as _h
    from cryptography.hazmat.primitives.serialization import Encoding

    p12_path = "/tmp/sc-cpe-signing.p12"
    with open(p12_path, "wb") as fh:
        fh.write(base64.b64decode(cfg.p12_b64))
    os.chmod(p12_path, 0o600)

    with open(p12_path, "rb") as fh:
        p12_bytes = fh.read()

    _key, cert, _add = pkcs12.load_key_and_certificates(
        p12_bytes, cfg.p12_password.encode("utf-8")
    )
    if cert is None:
        raise RuntimeError("PKCS#12 did not contain a certificate")
    cert_der = cert.public_bytes(Encoding.DER)
    cert_pem = cert.public_bytes(Encoding.PEM).decode("ascii")
    fpr = hashlib.sha256(cert_der).hexdigest()
    log("info", "signing_material_loaded", cert_sha256=fpr)
    return SigningMaterial(
        p12_path=p12_path,
        p12_password=cfg.p12_password,
        cert_der_sha256=fpr,
        cert_pem=cert_pem,
    )


# ---------------------------------------------------------------------------
# PDF rendering + signing
# ---------------------------------------------------------------------------


def _qr_svg_data_uri(url: str) -> str:
    """Render `url` as a QR code and return a `data:image/svg+xml;base64,...`
    URI suitable for an <img src=...>. High error-correction so the QR still
    scans if the printed cert is lightly scuffed."""
    import io
    import segno
    buf = io.BytesIO()
    segno.make(url, error="h").save(buf, kind="svg", scale=1, border=0)
    return "data:image/svg+xml;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def render_pdf(
    jinja_env: Environment,
    *,
    issuer_name: str,
    recipient_name: str,
    period_start: dt.date,
    period_end: dt.date,
    period_display: str,
    attended_line: str,
    dates_line: str,
    cpe_total: float,
    sessions_count: int,
    cert_id: str,
    public_token: str,
    verify_url: str,
    issued_at: str,
    signing_cert_sha256: str,
) -> bytes:
    template = jinja_env.get_template("template.html")
    # Render cpe_total like "5.5" not "5.500000"
    if float(cpe_total).is_integer():
        cpe_total_str = f"{int(cpe_total)}"
    else:
        cpe_total_str = f"{float(cpe_total):.1f}"

    # Inline SVG QR code pointing at the verify URL. Embedded as a data URI
    # so WeasyPrint rasterises it without an external fetch. SVG beats PNG
    # because the QR stays crisp at any print scale.
    qr_svg = _qr_svg_data_uri(verify_url)

    activity_description = (
        "Live daily cybersecurity briefing covering current threats, "
        "vulnerabilities, and defensive strategies. Topics include "
        "risk management, security operations, incident response, "
        "and governance — aligned with ISACA, ISC\u00b2, and CompTIA "
        "continuing education domains."
    )

    html_str = template.render(
        issuer_name=issuer_name,
        recipient_name=recipient_name,
        period_start=period_start.isoformat(),
        period_end=period_end.isoformat(),
        period_display=period_display,
        attended_line=attended_line,
        dates_line=dates_line,
        activity_description=activity_description,
        cpe_total=cpe_total_str,
        sessions_count=sessions_count,
        cert_id_display=cert_id[:12],
        public_token_short=public_token[:16],
        verify_url=verify_url,
        verify_qr_data_uri=qr_svg,
        issued_at=issued_at,
        signing_cert_sha256=signing_cert_sha256,
    )
    pdf_bytes = HTML(string=html_str).write_pdf()
    if not pdf_bytes:
        raise RuntimeError("WeasyPrint produced empty PDF")
    return pdf_bytes


# DER-encoded OID for id-aa-signatureTimeStampToken (1.2.840.113549.1.9.16.2.14).
# PDF signatures store the CMS blob hex-encoded inside /Contents<...>, so we
# search for both the raw DER bytes (belt) and the ASCII-hex form (suspenders).
_SIG_TS_TOKEN_OID_DER = bytes.fromhex("060B2A864886F70D010910020E")
_SIG_TS_TOKEN_OID_HEX = _SIG_TS_TOKEN_OID_DER.hex().encode("ascii")


def _signed_pdf_has_timestamp_token(signed_pdf: bytes) -> bool:
    """Sanity-check that the CMS blob embedded in the signed PDF carries an
    RFC-3161 signature-timestamp-token unsigned attribute. Cheap byte-level
    check — PDFs hex-encode the CMS under /Contents, so we match either form."""
    lower = signed_pdf.lower()
    return (
        _SIG_TS_TOKEN_OID_DER in signed_pdf
        or _SIG_TS_TOKEN_OID_HEX in lower
    )


def sign_pdf_pades(
    unsigned_pdf: bytes,
    sig: SigningMaterial,
    *,
    issuer_name: str,
    cert_id: str,
    tsa_url: str,
    tsa_urls_fallback: list[str] | None = None,
    tsa_required: bool,
) -> bytes:
    """PAdES-sign the PDF with endesive, countersigned by an RFC-3161 TSA.

    endesive.pdf.cms.sign(datau, udct, key, cert, othercerts, algo) returns
    the signature bytes that must be *appended* to the original PDF to form
    the final signed document. The `udct` dict drives the visible signature
    metadata and, when `timestampurl` is set, triggers an RFC-3161 request
    via rfc3161ng; the returned timestamp token is embedded as an unsigned
    attribute on the SignerInfo, producing a PAdES-T level signature.

    Fail-closed: if `tsa_required` (default) and either the TSA call fails
    or the resulting PDF does not contain a signature-timestamp-token
    attribute, we raise. Shipping an unstamped cert means it becomes
    unverifiable when our 10-year self-signed cert expires.
    """
    from cryptography.hazmat.primitives.serialization import pkcs12

    with open(sig.p12_path, "rb") as fh:
        p12_bytes = fh.read()
    priv_key, cert, other_certs = pkcs12.load_key_and_certificates(
        p12_bytes, sig.p12_password.encode("utf-8")
    )
    if priv_key is None or cert is None:
        raise RuntimeError("PKCS#12 missing key or certificate")

    udct: dict[str, Any] = {
        "sigflags": 3,
        "sigpage": 0,
        "sigbutton": False,
        "contact": issuer_name,
        "location": "https://simplycyber.io",
        "signingdate": dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S+00'00'"),
        "reason": f"Simply Cyber CPE certificate {cert_id[:12]}",
        # Reserve fixed signature slot. endesive's auto-precompute path
        # under-allocates when an RFC-3161 timestamp token is embedded
        # (asserts len(zeros) == len(contents)); 32768 hex bytes (16 KiB)
        # is comfortably above a SHA-256 CMS + TSA response.
        "aligned": 32768,
    }

    # Cascade through TSAs: primary first, then fallbacks in order. Any one
    # returning a valid timestamp token is sufficient. A single TSA outage
    # (freetsa.org has been down for days at a time historically) would
    # otherwise block every cert issuance.
    candidates = [u for u in ([tsa_url] + list(tsa_urls_fallback or [])) if u]
    last_err: Exception | None = None
    used_tsa: str | None = None
    signed_pdf: bytes | None = None
    for candidate in candidates:
        try:
            signature = endesive_cms.sign(
                unsigned_pdf,
                udct,
                priv_key,
                cert,
                other_certs or [],
                "sha256",
                timestampurl=candidate,
            )
            candidate_pdf = unsigned_pdf + signature
            if _signed_pdf_has_timestamp_token(candidate_pdf):
                signed_pdf = candidate_pdf
                used_tsa = candidate
                break
            last_err = RuntimeError(
                f"TSA {candidate} returned no signature-timestamp-token"
            )
            log("warn", "tsa_no_token", tsa_url=candidate, cert_id=cert_id)
        except Exception as e:
            last_err = e
            log("warn", "tsa_failed", tsa_url=candidate, error=str(e)[:200], cert_id=cert_id)

    if signed_pdf is None:
        if tsa_required:
            raise RuntimeError(
                f"All TSAs failed ({candidates}); last error: {last_err}. "
                f"Refusing to ship untimestamped cert."
            ) from last_err
        # tsa_required=False → fall back to unstamped signing (dev/test only)
        signature = endesive_cms.sign(
            unsigned_pdf, udct, priv_key, cert, other_certs or [], "sha256",
        )
        signed_pdf = unsigned_pdf + signature

    has_ts = _signed_pdf_has_timestamp_token(signed_pdf)
    log(
        "info",
        "pdf_pades_level",
        cert_id=cert_id,
        tsa_url=used_tsa,
        pades_level=("PAdES-T" if has_ts else "PAdES-B"),
    )
    return signed_pdf


# ---------------------------------------------------------------------------
# R2 upload helpers
# ---------------------------------------------------------------------------


def make_r2_client(cfg: Config):
    return boto3.client(
        "s3",
        endpoint_url=cfg.r2_endpoint_url,
        aws_access_key_id=cfg.r2_access_key_id,
        aws_secret_access_key=cfg.r2_secret_access_key,
        region_name="auto",
        config=BotoConfig(signature_version="s3v4", retries={"max_attempts": 3}),
    )


def upload_and_verify(
    s3, bucket: str, key: str, body: bytes, *, content_type: str, cache_control: str
) -> None:
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType=content_type,
        CacheControl=cache_control,
    )
    head = s3.head_object(Bucket=bucket, Key=key)
    remote_size = int(head["ContentLength"])
    if remote_size != len(body):
        raise RuntimeError(
            f"R2 HEAD mismatch for s3://{bucket}/{key}: "
            f"expected {len(body)} bytes, got {remote_size}"
        )


# ---------------------------------------------------------------------------
# Email (Resend)
# ---------------------------------------------------------------------------


RESEND_URL = "https://api.resend.com/emails"


def send_resend_email(
    *,
    api_key: str,
    from_email: str,
    to_email: str,
    subject: str,
    html_body: str,
    text_body: str,
    idempotency_key: str,
) -> str:
    resp = requests.post(
        RESEND_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Idempotency-Key": idempotency_key,
        },
        json={
            "from": from_email,
            "to": [to_email],
            "subject": subject,
            "html": html_body,
            "text": text_body,
        },
        timeout=30,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"Resend failed {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    msg_id = data.get("id") or ""
    if not msg_id:
        raise RuntimeError(f"Resend response missing id: {data}")
    return msg_id


def build_email_bodies(
    *,
    recipient_name: str,
    period_display: str,
    attended_line: str,
    dates_line: str,
    cpe_total: float,
    sessions_count: int,
    verify_url: str,
    download_url: str,
    issuer_name: str,
) -> tuple[str, str]:
    if float(cpe_total).is_integer():
        cpe_str = f"{int(cpe_total)}"
    else:
        cpe_str = f"{float(cpe_total):.1f}"

    dates_text_block = f"  Sessions: {dates_line}\n" if dates_line else ""
    dates_html_line = (
        f'<li>Sessions: <strong>{dates_line}</strong></li>' if dates_line else ""
    )
    attended_sentence = f"Attendance recorded {attended_line}."

    text = (
        f"Hi {recipient_name},\n\n"
        f"Your {period_display} Simply Cyber CPE certificate is ready.\n"
        f"{attended_sentence}\n\n"
        f"  CPE credit hours: {cpe_str}\n"
        f"  Sessions attended: {sessions_count}\n"
        f"{dates_text_block}\n"
        f"Download your signed PDF:\n  {download_url}\n\n"
        f"Anyone (including auditors) can verify this certificate at:\n  {verify_url}\n\n"
        f"The signed PDF is PAdES-signed; most PDF readers will show the "
        f"embedded digital signature and the certifying authority "
        f"({issuer_name}).\n\n"
        f"— {issuer_name}\n"
    )
    html = f"""<!doctype html>
<html><body style="font-family:Helvetica,Arial,sans-serif;color:#111;line-height:1.45;">
<p>Hi {recipient_name},</p>
<p>Your <strong>{period_display}</strong> Simply Cyber CPE certificate is ready.
{attended_sentence}</p>
<ul>
  <li>CPE credit hours: <strong>{cpe_str}</strong></li>
  <li>Sessions attended: <strong>{sessions_count}</strong></li>
  {dates_html_line}
</ul>
<p>
  <a href="{download_url}"
     style="display:inline-block;background:#0b3d5c;color:#fff;
            padding:10px 16px;border-radius:4px;text-decoration:none;">
     Download signed PDF
  </a><br/>
  <small style="color:#666;">Link does not expire — you can re-download anytime.</small>
</p>
<p>
  Anyone (including auditors) can verify this certificate:<br/>
  <a href="{verify_url}">{verify_url}</a>
</p>
<p>The signed PDF is PAdES-signed; most PDF readers will show the
embedded digital signature and the certifying authority ({issuer_name}).</p>
<p>— {issuer_name}</p>
</body></html>"""
    return html, text


# ---------------------------------------------------------------------------
# Per-user issuance
# ---------------------------------------------------------------------------


@dataclass
class Stats:
    eligible: int = 0
    issued: int = 0
    skipped_already_issued: int = 0
    errored: int = 0
    errors: list[dict[str, Any]] = field(default_factory=list)


def already_issued(d1: D1Client, user_id: str, period_yyyymm: str) -> bool:
    rows = d1.query(
        "SELECT 1 AS ok FROM certs WHERE user_id = ? AND period_yyyymm = ? "
        "AND cert_kind = 'bundled' AND state != 'revoked' LIMIT 1",
        [user_id, period_yyyymm],
    )
    return bool(rows)


def already_issued_per_session(d1: D1Client, user_id: str, stream_pk: str) -> bool:
    rows = d1.query(
        "SELECT 1 AS ok FROM certs WHERE user_id = ? AND stream_id = ? "
        "AND cert_kind = 'per_session' AND state != 'revoked' LIMIT 1",
        [user_id, stream_pk],
    )
    return bool(rows)


def issue_for_user(
    *,
    cfg: Config,
    d1: D1Client,
    s3,
    jinja_env: Environment,
    sig: SigningMaterial,
    user_row: dict[str, Any],
    period_yyyymm: str,
    period_start_date: dt.date,
    period_end_date: dt.date,
    period_display: str,
    cert_kind: str = "bundled",
    stream_row: dict[str, Any] | None = None,
    existing_cert_id: str | None = None,
    existing_public_token: str | None = None,
    supersedes_cert_id: str | None = None,
) -> None:
    """Issue one cert. cert_kind='bundled' aggregates all eligible sessions
    (user_row must carry cpe_total/sessions_count/session_video_ids/session_dates
    from ELIGIBLE_SQL). cert_kind='per_session' issues a single-session cert;
    stream_row is required and supplies stream_pk/yt_video_id/scheduled_date/
    earned_cpe/title.

    existing_cert_id/public_token are set when this call is fulfilling a
    pre-inserted 'pending' row (on-demand per_session request or admin
    reissue); the row is UPDATEd instead of INSERTed.

    supersedes_cert_id wires the reissue chain: on successful delivery the
    superseded cert flips to state='regenerated'. audit action becomes
    'cert_regenerated' so the chain tells the story.
    """
    user_id = user_row["id"]
    email = user_row["email"]
    recipient_name = user_row["legal_name"]

    if cert_kind == "per_session":
        if not stream_row:
            raise ValueError("per_session issuance requires stream_row")
        cpe_total = float(stream_row["earned_cpe"])
        sessions_count = 1
        session_date = stream_row["scheduled_date"]
        attended_line = f"on {_format_long_date(session_date)}"
        dates_line = ""
        # Subject-line period for single-session certs reads the date, not
        # the month — users get one email per session so "March 2026" would
        # be confusing when they attended the 15th and 22nd both that month.
        per_session_period_display = _format_long_date(session_date)
        video_ids = [stream_row["yt_video_id"]]
        stream_pk = stream_row["stream_pk"]
    else:
        cpe_total = float(user_row["cpe_total"])
        sessions_count = int(user_row["sessions_count"])
        attended_line, dates_line = attendance_phrasing(
            user_row.get("session_dates"), sessions_count, period_display,
        )
        session_video_ids_raw = user_row.get("session_video_ids") or ""
        video_ids = sorted(
            {v for v in (session_video_ids_raw.split(",") if session_video_ids_raw else []) if v}
        )
        per_session_period_display = period_display
        stream_pk = None

    session_video_ids_json = json.dumps(video_ids)

    cert_id = existing_cert_id or new_ulid()
    public_token = existing_public_token or new_public_token()
    issued_at = now_iso_utc()
    verify_url = f"{cfg.verify_base_url}?t={public_token}"

    log(
        "info",
        "issue_begin",
        user_id=user_id,
        period=period_yyyymm,
        cert_id=cert_id,
        sessions=sessions_count,
        cpe=cpe_total,
    )

    # 2. Render
    unsigned_pdf = render_pdf(
        jinja_env,
        issuer_name=cfg.issuer_name,
        recipient_name=recipient_name,
        period_start=period_start_date,
        period_end=period_end_date,
        period_display=per_session_period_display,
        attended_line=attended_line,
        dates_line=dates_line,
        cpe_total=cpe_total,
        sessions_count=sessions_count,
        cert_id=cert_id,
        public_token=public_token,
        verify_url=verify_url,
        issued_at=issued_at,
        signing_cert_sha256=sig.cert_der_sha256,
    )
    unsigned_sha = sha256_bytes(unsigned_pdf)
    log("info", "pdf_rendered", cert_id=cert_id, bytes=len(unsigned_pdf), sha256=unsigned_sha)

    # 3/4/5. Sign (with RFC-3161 TSA countersignature -> PAdES-T)
    signed_pdf = sign_pdf_pades(
        unsigned_pdf,
        sig,
        issuer_name=cfg.issuer_name,
        cert_id=cert_id,
        tsa_url=cfg.tsa_url,
        tsa_urls_fallback=cfg.tsa_urls_fallback,
        tsa_required=cfg.tsa_required,
    )
    signed_sha = sha256_bytes(signed_pdf)
    log("info", "pdf_signed", cert_id=cert_id, bytes=len(signed_pdf), sha256=signed_sha)

    # 7. Upload to R2
    r2_key = f"certs/{user_id}/{cert_id}.pdf"
    upload_and_verify(
        s3,
        cfg.cert_r2_bucket,
        r2_key,
        signed_pdf,
        content_type="application/pdf",
        cache_control="private, max-age=86400",
    )
    log("info", "r2_uploaded", cert_id=cert_id, bucket=cfg.cert_r2_bucket, key=r2_key)

    # 9. Durable download URL (Pages /api/download/{token} streams from R2).
    # We intentionally do NOT presign an R2 URL here — S3 presigned URLs
    # cap at 7 days, and we need the link in the cert email to remain
    # reachable indefinitely. The Pages endpoint checks revocation state
    # and audit-logs each download.
    download_url = f"{cfg.download_base_url.rstrip('/')}/{public_token}"

    # 10. Write certs row. When filling a pending row (on-demand per_session
    # or admin reissue) we UPDATE; fresh bundled/per_session from the monthly
    # sweep INSERTs.
    if existing_cert_id:
        d1.execute(
            """
            UPDATE certs
               SET issuer_name_snapshot = ?, recipient_name_snapshot = ?,
                   signing_cert_sha256 = ?, pdf_r2_key = ?, pdf_sha256 = ?,
                   cpe_total = ?, sessions_count = ?, session_video_ids = ?,
                   state = 'generated', generated_at = ?
             WHERE id = ?
            """,
            [
                cfg.issuer_name, recipient_name,
                sig.cert_der_sha256, r2_key, signed_sha,
                cpe_total, sessions_count, session_video_ids_json,
                issued_at, cert_id,
            ],
        )
        log("info", "certs_updated", cert_id=cert_id, state="generated")
    else:
        d1.execute(
            """
            INSERT INTO certs (
                id, public_token, user_id,
                period_yyyymm, period_start, period_end,
                cpe_total, sessions_count, session_video_ids,
                issuer_name_snapshot, recipient_name_snapshot,
                signing_cert_sha256, pdf_r2_key, pdf_sha256,
                state, cert_kind, stream_id,
                generated_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      'generated', ?, ?, ?, ?)
            """,
            [
                cert_id, public_token, user_id,
                period_yyyymm,
                period_start_date.isoformat(),
                period_end_date.isoformat(),
                cpe_total, sessions_count, session_video_ids_json,
                cfg.issuer_name, recipient_name,
                sig.cert_der_sha256, r2_key, signed_sha,
                cert_kind, stream_pk,
                issued_at, issued_at,
            ],
        )
        log("info", "certs_inserted", cert_id=cert_id,
            state="generated", cert_kind=cert_kind)

    # 11. Queue email_outbox (idempotent on cert_id)
    email_id = new_ulid()
    if cert_kind == "per_session":
        subject = f"Your {per_session_period_display} Daily Threat Briefing cert"
    else:
        subject = f"Your {period_display} CPE certificate"
    html_body, text_body = build_email_bodies(
        recipient_name=recipient_name,
        period_display=per_session_period_display,
        attended_line=attended_line,
        dates_line=dates_line,
        cpe_total=cpe_total,
        sessions_count=sessions_count,
        verify_url=verify_url,
        download_url=download_url,
        issuer_name=cfg.issuer_name,
    )

    # Pre-render html_body/text_body into payload_json so the email-sender
    # drainer can dispatch the row without re-rendering. The cron also tries
    # an inline send below; if that fails we leave the row in 'queued' so the
    # drainer's retry path picks it up instead of dropping the email.
    payload_json = json.dumps(
        {
            "cert_id": cert_id,
            "period_yyyymm": period_yyyymm,
            "period_display": period_display,
            "cpe_total": cpe_total,
            "sessions_count": sessions_count,
            "verify_url": verify_url,
            "download_url": download_url,
            "html_body": html_body,
            "text_body": text_body,
        }
    )

    d1.execute(
        """
        INSERT INTO email_outbox (
            id, user_id, template, to_email, subject,
            payload_json, idempotency_key, state, attempts, created_at
        ) VALUES (?, ?, 'monthly_cert', ?, ?, ?, ?, 'queued', 0, ?)
        """,
        [email_id, user_id, email, subject, payload_json, cert_id, issued_at],
    )
    log("info", "email_queued", cert_id=cert_id, email_id=email_id, to=email)

    # 12. Send via Resend; tolerate send failure (outbox still queued).
    try:
        d1.execute(
            "UPDATE email_outbox SET state = 'sending', attempts = attempts + 1 WHERE id = ?",
            [email_id],
        )
        msg_id = send_resend_email(
            api_key=cfg.resend_api_key,
            from_email=cfg.from_email,
            to_email=email,
            subject=subject,
            html_body=html_body,
            text_body=text_body,
            idempotency_key=cert_id,
        )
        sent_at = now_iso_utc()
        d1.execute(
            "UPDATE email_outbox SET state = 'sent', sent_at = ?, resend_message_id = ? "
            "WHERE id = ?",
            [sent_at, msg_id, email_id],
        )
        d1.execute(
            "UPDATE certs SET state = 'delivered', delivered_at = ? WHERE id = ?",
            [sent_at, cert_id],
        )
        log("info", "email_sent", cert_id=cert_id, resend_id=msg_id)
    except Exception as e:
        err_msg = str(e)[:500]
        log("warn", "email_send_failed", cert_id=cert_id, email_id=email_id, error=err_msg)
        try:
            # Roll the row back to 'queued' (not 'failed') so the email-sender
            # drainer can retry from the pre-rendered payload. attempts was
            # incremented above, so the drainer's MAX_ATTEMPTS cap still
            # applies — but a single transient Resend hiccup no longer drops
            # the email permanently.
            d1.execute(
                "UPDATE email_outbox SET state = 'queued', last_error = ? WHERE id = ?",
                [err_msg, email_id],
            )
        except Exception as inner:  # pragma: no cover
            log("error", "email_outbox_update_failed", error=str(inner))
        # Do NOT re-raise; the cert is in R2 and in D1 as 'generated', the
        # drainer will own delivery from here.

    # 13. Audit log (hash-chained). action is 'cert_regenerated' when this
    # fills a reissue-driven pending row, 'cert_issued' otherwise (including
    # on-demand per_session requests). The superseded cert flips to
    # 'regenerated' so the user dashboard hides it from the active list.
    if supersedes_cert_id:
        d1.execute(
            "UPDATE certs SET state = 'regenerated' WHERE id = ? AND state != 'revoked'",
            [supersedes_cert_id],
        )
    audit_action = "cert_regenerated" if supersedes_cert_id else "cert_issued"
    audit_id = insert_chained_audit(
        d1,
        actor_type="cron",
        actor_id="monthly-certs",
        action=audit_action,
        entity_type="certs",
        entity_id=cert_id,
        before_json=None,
        after_json=json.dumps(
            {
                "cert_id": cert_id,
                "user_id": user_id,
                "period_yyyymm": period_yyyymm,
                "cpe_total": cpe_total,
                "sessions_count": sessions_count,
                "cert_kind": cert_kind,
                "stream_id": stream_pk,
                "supersedes_cert_id": supersedes_cert_id,
                "pdf_r2_key": r2_key,
                "pdf_sha256": signed_sha,
                "signing_cert_sha256": sig.cert_der_sha256,
            }
        ),
    )
    log("info", "audit_logged", cert_id=cert_id, audit_id=audit_id,
        action=audit_action)

    # 14. Summary line
    log(
        "info",
        "issue_done",
        cert_id=cert_id,
        user_id=user_id,
        period=period_yyyymm,
        cpe_total=cpe_total,
        sessions=sessions_count,
        pdf_sha256=signed_sha,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


ELIGIBLE_SQL = """
SELECT u.id, u.email, u.legal_name, u.dashboard_token, u.email_prefs,
       SUM(a.earned_cpe) AS cpe_total,
       COUNT(*) AS sessions_count,
       MIN(s.scheduled_date) AS period_start,
       MAX(s.scheduled_date) AS period_end,
       GROUP_CONCAT(s.yt_video_id, ',') AS session_video_ids,
       GROUP_CONCAT(DISTINCT s.scheduled_date) AS session_dates
FROM users u
JOIN attendance a ON a.user_id = u.id
JOIN streams s ON s.id = a.stream_id
WHERE u.state = 'active'
  AND u.deleted_at IS NULL
  AND strftime('%Y%m', s.scheduled_date) = ?
GROUP BY u.id, u.email, u.legal_name, u.dashboard_token, u.email_prefs
HAVING SUM(a.earned_cpe) > 0
"""

# Per-session eligibility: one row per (user, stream). Consumed when a user
# has cert_style in ('per_session','both'). Cheaper to do one join + group by
# in memory than re-query per session.
ELIGIBLE_PER_SESSION_SQL = """
SELECT u.id AS user_id, u.email, u.legal_name, u.dashboard_token,
       s.id AS stream_pk, s.yt_video_id, s.scheduled_date, s.title,
       a.earned_cpe
  FROM users u
  JOIN attendance a ON a.user_id = u.id
  JOIN streams s ON s.id = a.stream_id
 WHERE u.state = 'active'
   AND u.deleted_at IS NULL
   AND strftime('%Y%m', s.scheduled_date) = ?
   AND a.earned_cpe > 0
"""


def get_cert_style(email_prefs_json: str | None) -> str:
    """users.email_prefs is a JSON blob; cert_style drives the monthly loop.
    Defaults to 'bundled' for backward compat (pre-migration users)."""
    try:
        prefs = json.loads(email_prefs_json or "{}") or {}
    except Exception:
        return "bundled"
    v = prefs.get("cert_style", "bundled")
    return v if v in ("bundled", "per_session", "both") else "bundled"


def _format_long_date(iso: str) -> str:
    """'2026-03-15' -> 'March 15, 2026'. Falls back to the ISO string on parse
    failure so a malformed row never breaks cert generation."""
    try:
        d = dt.date.fromisoformat(iso)
        return d.strftime("%B %-d, %Y") if os.name != "nt" else d.strftime("%B %#d, %Y")
    except Exception:
        return iso


def attendance_phrasing(
    session_dates_csv: str | None,
    sessions_count: int,
    period_display: str,
) -> tuple[str, str]:
    """Return (attended_line, dates_line) for the cert / email.

    Honesty matters for CPE audit: showing "March 1 – March 31" on a cert
    earned from a single attended day overstates participation. We use the
    actual dates instead.

    - 1 session:   attended "on March 15, 2026"; no dates line.
    - 2–5 sessions: attended "during March 2026"; list every date.
    - 6+ sessions:  attended "during March 2026"; first/last + total.
    """
    dates = sorted({d for d in (session_dates_csv or "").split(",") if d})
    if not dates:
        return (f"during {period_display}", "")
    if sessions_count == 1 or len(dates) == 1:
        return (f"on {_format_long_date(dates[0])}", "")
    if len(dates) <= 5:
        return (
            f"during {period_display}",
            " · ".join(_format_long_date(d) for d in dates),
        )
    return (
        f"during {period_display}",
        f"First {_format_long_date(dates[0])} · "
        f"Last {_format_long_date(dates[-1])} · "
        f"{len(dates)} sessions",
    )


PENDING_SQL = """
SELECT c.id, c.public_token, c.user_id,
       c.period_yyyymm, c.period_start, c.period_end,
       c.cpe_total, c.sessions_count, c.session_video_ids,
       c.cert_kind, c.stream_id, c.supersedes_cert_id,
       u.email, u.legal_name, u.dashboard_token, u.email_prefs,
       s.yt_video_id, s.scheduled_date, s.title AS stream_title
  FROM certs c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN streams s ON s.id = c.stream_id
 WHERE c.state = 'pending'
   AND u.deleted_at IS NULL
 ORDER BY c.created_at ASC
"""


def _period_dates(period_yyyymm: str,
                  fallback_start: str | None,
                  fallback_end: str | None) -> tuple[dt.date, dt.date, str]:
    """Given a YYYYMM + optional stored period_start/end strings, return
    (start_date, end_date, display). Used by pending-pickup where the cert
    row already carries the period bounds."""
    try:
        if fallback_start and fallback_end:
            start = dt.date.fromisoformat(fallback_start)
            end = dt.date.fromisoformat(fallback_end)
        else:
            y = int(period_yyyymm[:4])
            m = int(period_yyyymm[4:])
            start = dt.date(y, m, 1)
            if m == 12:
                end = dt.date(y + 1, 1, 1) - dt.timedelta(days=1)
            else:
                end = dt.date(y, m + 1, 1) - dt.timedelta(days=1)
        return start, end, start.strftime("%B %Y")
    except Exception:
        return dt.date.today(), dt.date.today(), period_yyyymm


def _run_pending_pickup(cfg: Config, d1: D1Client, s3, sig,
                        jinja_env: Environment) -> int:
    rows = d1.query(PENDING_SQL, [])
    stats = Stats(eligible=len(rows))
    log("info", "pending_pickup_begin", count=len(rows))
    stats_lock = threading.Lock()

    def _process(p: dict[str, Any]) -> None:
        cert_id = p["id"]
        try:
            period_start, period_end, period_display = _period_dates(
                p["period_yyyymm"], p.get("period_start"), p.get("period_end"),
            )
            user_row: dict[str, Any] = {
                "id": p["user_id"],
                "email": p["email"],
                "legal_name": p["legal_name"],
                "dashboard_token": p["dashboard_token"],
                "email_prefs": p.get("email_prefs"),
                "cpe_total": p["cpe_total"],
                "sessions_count": p["sessions_count"],
                "session_video_ids": p.get("session_video_ids") or "",
            }
            stream_row = None
            if p["cert_kind"] == "per_session":
                stream_row = {
                    "stream_pk": p["stream_id"],
                    "yt_video_id": p["yt_video_id"],
                    "scheduled_date": p["scheduled_date"],
                    "title": p.get("stream_title"),
                    "earned_cpe": p["cpe_total"],
                }
            else:
                dates_rows = d1.query(
                    "SELECT DISTINCT s.scheduled_date FROM attendance a "
                    "JOIN streams s ON s.id = a.stream_id "
                    "WHERE a.user_id = ? "
                    "AND strftime('%Y%m', s.scheduled_date) = ? "
                    "ORDER BY s.scheduled_date",
                    [p["user_id"], p["period_yyyymm"]],
                )
                user_row["session_dates"] = ",".join(
                    r["scheduled_date"] for r in dates_rows
                )

            issue_for_user(
                cfg=cfg, d1=d1, s3=s3, jinja_env=jinja_env, sig=sig,
                user_row=user_row,
                period_yyyymm=p["period_yyyymm"],
                period_start_date=period_start,
                period_end_date=period_end,
                period_display=period_display,
                cert_kind=p["cert_kind"] or "bundled",
                stream_row=stream_row,
                existing_cert_id=cert_id,
                existing_public_token=p["public_token"],
                supersedes_cert_id=p.get("supersedes_cert_id"),
            )
            with stats_lock:
                stats.issued += 1
        except Exception as e:
            tb = traceback.format_exc(limit=6)
            with stats_lock:
                stats.errored += 1
                stats.errors.append({"cert_id": cert_id, "error": str(e)})
            log("error", "pending_pickup_failed",
                cert_id=cert_id, error=str(e), trace=tb)

    if cfg.issue_workers <= 1 or len(rows) <= 1:
        for r in rows:
            _process(r)
    else:
        with ThreadPoolExecutor(max_workers=cfg.issue_workers) as pool:
            for _ in as_completed([pool.submit(_process, r) for r in rows]):
                pass

    log("info", "pending_pickup_done",
        eligible=stats.eligible, issued=stats.issued, errored=stats.errored)
    return 0 if stats.errored == 0 else 1


def main() -> int:
    pending_only = (
        os.environ.get("PENDING_ONLY", "").strip() in ("1", "true", "yes")
        or "--pending-only" in sys.argv
    )

    cfg = Config.from_env()
    d1 = D1Client(cfg.cf_account_id, cfg.d1_database_id, cfg.cf_api_token)
    s3 = make_r2_client(cfg)
    sig = load_signing_material(cfg)
    here = os.path.dirname(os.path.abspath(__file__))
    jinja_env = Environment(
        loader=FileSystemLoader(here),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )

    if pending_only:
        return _run_pending_pickup(cfg, d1, s3, sig, jinja_env)

    period_yyyymm, period_start, period_end, period_display = resolve_period(cfg)
    log(
        "info",
        "run_begin",
        period=period_yyyymm,
        period_display=period_display,
        period_start=period_start.isoformat(),
        period_end=period_end.isoformat(),
        override=bool(cfg.period_override),
    )

    bundled_rows = d1.query(ELIGIBLE_SQL, [period_yyyymm])
    per_session_rows = d1.query(ELIGIBLE_PER_SESSION_SQL, [period_yyyymm])

    # Index per-session rows by user_id for O(1) lookup during dispatch.
    per_session_by_user: dict[str, list[dict[str, Any]]] = {}
    for r in per_session_rows:
        per_session_by_user.setdefault(r["user_id"], []).append(r)

    stats = Stats(eligible=len(bundled_rows))
    log("info", "eligible_users",
        count=len(bundled_rows), per_session_candidates=len(per_session_rows),
        period=period_yyyymm, workers=cfg.issue_workers)

    stats_lock = threading.Lock()

    def _issue_bundled(row: dict[str, Any]) -> None:
        user_id = row["id"]
        if already_issued(d1, user_id, period_yyyymm):
            log("info", "skip_already_issued",
                user_id=user_id, period=period_yyyymm, kind="bundled")
            with stats_lock:
                stats.skipped_already_issued += 1
            return
        issue_for_user(
            cfg=cfg, d1=d1, s3=s3, jinja_env=jinja_env, sig=sig,
            user_row=row, period_yyyymm=period_yyyymm,
            period_start_date=period_start, period_end_date=period_end,
            period_display=period_display, cert_kind="bundled",
        )
        with stats_lock:
            stats.issued += 1

    def _issue_per_session(row: dict[str, Any], s_row: dict[str, Any]) -> None:
        if already_issued_per_session(d1, row["id"], s_row["stream_pk"]):
            log("info", "skip_already_issued",
                user_id=row["id"], stream_id=s_row["stream_pk"],
                kind="per_session")
            with stats_lock:
                stats.skipped_already_issued += 1
            return
        issue_for_user(
            cfg=cfg, d1=d1, s3=s3, jinja_env=jinja_env, sig=sig,
            user_row=row, period_yyyymm=period_yyyymm,
            period_start_date=period_start, period_end_date=period_end,
            period_display=period_display,
            cert_kind="per_session", stream_row=s_row,
        )
        with stats_lock:
            stats.issued += 1

    def _process(row: dict[str, Any]) -> None:
        user_id = row.get("id")
        style = get_cert_style(row.get("email_prefs"))
        try:
            if style in ("bundled", "both"):
                _issue_bundled(row)
            if style in ("per_session", "both"):
                for s_row in per_session_by_user.get(user_id, []):
                    try:
                        _issue_per_session(row, s_row)
                    except Exception as se:
                        tb = traceback.format_exc(limit=6)
                        with stats_lock:
                            stats.errored += 1
                            stats.errors.append({
                                "user_id": user_id,
                                "stream_id": s_row.get("stream_pk"),
                                "error": str(se),
                            })
                        log("error", "issue_failed",
                            user_id=user_id,
                            stream_id=s_row.get("stream_pk"),
                            kind="per_session",
                            error=str(se), trace=tb)
        except Exception as e:
            tb = traceback.format_exc(limit=6)
            with stats_lock:
                stats.errored += 1
                stats.errors.append({"user_id": user_id, "error": str(e)})
            log("error", "issue_failed",
                user_id=user_id, period=period_yyyymm,
                error=str(e), trace=tb)

    if cfg.issue_workers <= 1 or len(bundled_rows) <= 1:
        for row in bundled_rows:
            _process(row)
    else:
        with ThreadPoolExecutor(max_workers=cfg.issue_workers) as pool:
            for _ in as_completed([pool.submit(_process, r) for r in bundled_rows]):
                pass

    log(
        "info",
        "run_done",
        period=period_yyyymm,
        eligible=stats.eligible,
        issued=stats.issued,
        skipped_already_issued=stats.skipped_already_issued,
        errored=stats.errored,
    )

    return 0 if stats.errored == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
