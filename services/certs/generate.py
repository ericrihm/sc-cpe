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
  7. Generates a 30-day presigned download URL.
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
import traceback
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

    tsa_url: str
    tsa_required: bool

    period_override: str | None = None

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
            from_email=os.environ.get("FROM_EMAIL", "certs@simplycyber.io"),
            issuer_name=os.environ.get("ISSUER_NAME", "Simply Cyber LLC"),
            verify_base_url=os.environ.get(
                "VERIFY_BASE_URL", "https://cpe.simplycyber.io/verify.html"
            ),
            tsa_url=os.environ.get("TSA_URL", "https://freetsa.org/tsr"),
            tsa_required=(os.environ.get("TSA_REQUIRED", "1").strip().lower()
                          not in ("0", "false", "no", "")),
            period_override=(os.environ.get("PERIOD_YYYYMM") or "").strip() or None,
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


def render_pdf(
    jinja_env: Environment,
    *,
    issuer_name: str,
    recipient_name: str,
    period_start: dt.date,
    period_end: dt.date,
    period_display: str,
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

    html_str = template.render(
        issuer_name=issuer_name,
        recipient_name=recipient_name,
        period_start=period_start.isoformat(),
        period_end=period_end.isoformat(),
        period_display=period_display,
        cpe_total=cpe_total_str,
        sessions_count=sessions_count,
        cert_id_display=cert_id[:12],
        public_token_short=public_token[:16],
        verify_url=verify_url,
        issued_at=issued_at,
        signing_cert_sha256=signing_cert_sha256,
    )
    pdf_bytes = HTML(string=html_str).write_pdf()
    if not pdf_bytes:
        raise RuntimeError("WeasyPrint produced empty PDF")
    return pdf_bytes


# DER-encoded OID for id-aa-signatureTimeStampToken (1.2.840.113549.1.9.16.2.14).
# Presence of this byte sequence inside the PDF's /Contents CMS blob indicates a
# PAdES-T (or higher) signature, i.e. the signer's hash was countersigned by an
# RFC-3161 TSA. Absence means the signature will become unverifiable once our
# self-signed cert expires, which is the exact failure mode we're guarding.
_SIG_TS_TOKEN_OID_DER = bytes.fromhex("060B2A864886F70D010910020E")


def _signed_pdf_has_timestamp_token(signed_pdf: bytes) -> bool:
    """Sanity-check that the CMS blob embedded in the signed PDF carries an
    RFC-3161 signature-timestamp-token unsigned attribute. This is a byte-level
    check — cheap, avoids a second dependency on pyhanko, and is sufficient
    as a fail-closed guard. Full cryptographic validation happens in readers
    (Adobe Reader, pyhanko) and in our CI verification step."""
    return _SIG_TS_TOKEN_OID_DER in signed_pdf


def sign_pdf_pades(
    unsigned_pdf: bytes,
    sig: SigningMaterial,
    *,
    issuer_name: str,
    cert_id: str,
    tsa_url: str,
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
        "signform": False,
        "signaturebox": (0, 0, 0, 0),  # invisible signature; visible text is in the PDF body
    }
    if tsa_url:
        udct["timestampurl"] = tsa_url

    try:
        signature = endesive_cms.sign(
            unsigned_pdf,
            udct,
            priv_key,
            cert,
            other_certs or [],
            "sha256",
        )
    except Exception as e:
        if tsa_required and tsa_url:
            raise RuntimeError(
                f"PAdES signing failed (TSA={tsa_url}): {e}. "
                f"Refusing to ship untimestamped cert."
            ) from e
        raise

    signed_pdf = unsigned_pdf + signature

    has_ts = _signed_pdf_has_timestamp_token(signed_pdf)
    if tsa_required and not has_ts:
        raise RuntimeError(
            f"Signed PDF lacks RFC-3161 signature-timestamp-token (TSA={tsa_url}). "
            f"Refusing to ship: cert would become unverifiable when signing cert expires."
        )
    log(
        "info",
        "pdf_pades_level",
        cert_id=cert_id,
        tsa_url=tsa_url or None,
        level=("PAdES-T" if has_ts else "PAdES-B"),
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


def presign_download(s3, bucket: str, key: str, *, seconds: int = 30 * 24 * 3600) -> str:
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=seconds,
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

    text = (
        f"Hi {recipient_name},\n\n"
        f"Your {period_display} Simply Cyber CPE certificate is ready.\n\n"
        f"  CPE credit hours: {cpe_str}\n"
        f"  Sessions attended: {sessions_count}\n\n"
        f"Download your signed PDF (link valid for 30 days):\n  {download_url}\n\n"
        f"Anyone (including auditors) can verify this certificate at:\n  {verify_url}\n\n"
        f"The signed PDF is PAdES-signed; most PDF readers will show the "
        f"embedded digital signature and the certifying authority "
        f"({issuer_name}).\n\n"
        f"— {issuer_name}\n"
    )
    html = f"""<!doctype html>
<html><body style="font-family:Helvetica,Arial,sans-serif;color:#111;line-height:1.45;">
<p>Hi {recipient_name},</p>
<p>Your <strong>{period_display}</strong> Simply Cyber CPE certificate is ready.</p>
<ul>
  <li>CPE credit hours: <strong>{cpe_str}</strong></li>
  <li>Sessions attended: <strong>{sessions_count}</strong></li>
</ul>
<p>
  <a href="{download_url}"
     style="display:inline-block;background:#0b3d5c;color:#fff;
            padding:10px 16px;border-radius:4px;text-decoration:none;">
     Download signed PDF
  </a><br/>
  <small style="color:#666;">Link valid for 30 days.</small>
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
        "AND state != 'revoked' LIMIT 1",
        [user_id, period_yyyymm],
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
) -> None:
    user_id = user_row["id"]
    email = user_row["email"]
    recipient_name = user_row["legal_name"]

    cpe_total = float(user_row["cpe_total"])
    sessions_count = int(user_row["sessions_count"])
    session_video_ids_raw = user_row.get("session_video_ids") or ""
    # Dedup + normalize the comma-joined list from GROUP_CONCAT.
    video_ids = sorted(
        {v for v in (session_video_ids_raw.split(",") if session_video_ids_raw else []) if v}
    )
    session_video_ids_json = json.dumps(video_ids)

    cert_id = new_ulid()
    public_token = new_public_token()
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
        period_display=period_display,
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

    # 9. Presigned URL for the email link
    download_url = presign_download(s3, cfg.cert_r2_bucket, r2_key, seconds=30 * 24 * 3600)

    # 10. INSERT certs row (state='generated')
    d1.execute(
        """
        INSERT INTO certs (
            id, public_token, user_id,
            period_yyyymm, period_start, period_end,
            cpe_total, sessions_count, session_video_ids,
            issuer_name_snapshot, recipient_name_snapshot,
            signing_cert_sha256, pdf_r2_key, pdf_sha256,
            state, generated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generated', ?, ?)
        """,
        [
            cert_id,
            public_token,
            user_id,
            period_yyyymm,
            period_start_date.isoformat(),
            period_end_date.isoformat(),
            cpe_total,
            sessions_count,
            session_video_ids_json,
            cfg.issuer_name,
            recipient_name,
            sig.cert_der_sha256,
            r2_key,
            signed_sha,
            issued_at,
            issued_at,
        ],
    )
    log("info", "certs_inserted", cert_id=cert_id, state="generated")

    # 11. Queue email_outbox (idempotent on cert_id)
    email_id = new_ulid()
    subject = f"Your {period_display} CPE certificate"
    html_body, text_body = build_email_bodies(
        recipient_name=recipient_name,
        period_display=period_display,
        cpe_total=cpe_total,
        sessions_count=sessions_count,
        verify_url=verify_url,
        download_url=download_url,
        issuer_name=cfg.issuer_name,
    )

    payload_json = json.dumps(
        {
            "cert_id": cert_id,
            "period_yyyymm": period_yyyymm,
            "period_display": period_display,
            "cpe_total": cpe_total,
            "sessions_count": sessions_count,
            "verify_url": verify_url,
            "download_url": download_url,
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
            d1.execute(
                "UPDATE email_outbox SET state = 'failed', last_error = ? WHERE id = ?",
                [err_msg, email_id],
            )
        except Exception as inner:  # pragma: no cover
            log("error", "email_outbox_update_failed", error=str(inner))
        # Do NOT re-raise; the cert is in R2 and in D1 as 'generated', the
        # watchdog/retry job can pick up the queued email.

    # 13. Audit log (hash-chained)
    audit_id = insert_chained_audit(
        d1,
        actor_type="cron",
        actor_id="monthly-certs",
        action="cert_issued",
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
                "pdf_r2_key": r2_key,
                "pdf_sha256": signed_sha,
                "signing_cert_sha256": sig.cert_der_sha256,
            }
        ),
    )
    log("info", "audit_logged", cert_id=cert_id, audit_id=audit_id)

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
SELECT u.id, u.email, u.legal_name, u.dashboard_token,
       SUM(a.earned_cpe) AS cpe_total,
       COUNT(*) AS sessions_count,
       MIN(s.scheduled_date) AS period_start,
       MAX(s.scheduled_date) AS period_end,
       GROUP_CONCAT(s.yt_video_id, ',') AS session_video_ids
FROM users u
JOIN attendance a ON a.user_id = u.id
JOIN streams s ON s.id = a.stream_id
WHERE u.state = 'active'
  AND u.deleted_at IS NULL
  AND strftime('%Y%m', s.scheduled_date) = ?
GROUP BY u.id, u.email, u.legal_name, u.dashboard_token
HAVING SUM(a.earned_cpe) > 0
"""


def main() -> int:
    cfg = Config.from_env()
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

    d1 = D1Client(cfg.cf_account_id, cfg.d1_database_id, cfg.cf_api_token)
    s3 = make_r2_client(cfg)
    sig = load_signing_material(cfg)

    # Jinja env scoped to the template directory (this file's dir).
    here = os.path.dirname(os.path.abspath(__file__))
    jinja_env = Environment(
        loader=FileSystemLoader(here),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )

    users = d1.query(ELIGIBLE_SQL, [period_yyyymm])
    stats = Stats(eligible=len(users))
    log("info", "eligible_users", count=len(users), period=period_yyyymm)

    for row in users:
        user_id = row.get("id")
        try:
            if already_issued(d1, user_id, period_yyyymm):
                log(
                    "info",
                    "skip_already_issued",
                    user_id=user_id,
                    period=period_yyyymm,
                )
                stats.skipped_already_issued += 1
                continue

            issue_for_user(
                cfg=cfg,
                d1=d1,
                s3=s3,
                jinja_env=jinja_env,
                sig=sig,
                user_row=row,
                period_yyyymm=period_yyyymm,
                period_start_date=period_start,
                period_end_date=period_end,
                period_display=period_display,
            )
            stats.issued += 1
        except Exception as e:
            stats.errored += 1
            tb = traceback.format_exc(limit=6)
            err = {"user_id": user_id, "error": str(e), "trace": tb}
            stats.errors.append(err)
            log(
                "error",
                "issue_failed",
                user_id=user_id,
                period=period_yyyymm,
                error=str(e),
                trace=tb,
            )
            # Continue with the next user.

    log(
        "info",
        "run_done",
        period=period_yyyymm,
        eligible=stats.eligible,
        issued=stats.issued,
        skipped_already_issued=stats.skipped_already_issued,
        errored=stats.errored,
    )

    # Exit 0 if no errors. Nonzero on any per-user failure so CI flags it.
    return 0 if stats.errored == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
