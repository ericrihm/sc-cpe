#!/usr/bin/env python3
"""Render an unsigned sample CPE cert for the README.

Produces docs/assets/sample-cert.pdf and docs/assets/sample-cert.png from
services/certs/template.html with fake Jane-Doe attendance data. Uses the
same Jinja context shape as production render_pdf() so the sample always
looks like a real cert, minus the PAdES signature layer.

Run: .venv-sample/bin/python scripts/generate_sample_cert.py
"""
from __future__ import annotations

import base64
import hashlib
import sys
from pathlib import Path

import fitz
import segno
from jinja2 import Environment, FileSystemLoader, select_autoescape
from weasyprint import HTML

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_DIR = ROOT / "services" / "certs"
OUT_DIR = ROOT / "docs" / "assets"


def qr_svg_data_uri(url: str) -> str:
    qr = segno.make(url, error="m")
    buf = qr.svg_inline(scale=8, border=0, dark="#0b3d5c")
    return "data:image/svg+xml;base64," + base64.b64encode(buf.encode()).decode()


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    env = Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        autoescape=select_autoescape(["html"]),
    )
    template = env.get_template("template.html")

    sample_dates = [
        "March 02, 2026", "March 03, 2026", "March 04, 2026",
        "March 09, 2026", "March 10, 2026", "March 11, 2026",
        "March 16, 2026", "March 17, 2026", "March 18, 2026",
        "March 23, 2026", "March 24, 2026", "March 25, 2026",
    ]
    sessions_count = len(sample_dates)
    cpe_total = sessions_count * 0.5
    cert_id = "01JX7Z9SAMPLE0000DEMOCERT00"
    public_token = "demo-sample-not-a-real-cert-0000"
    verify_url = f"https://sc-cpe-web.pages.dev/verify.html?t={public_token}"

    fake_fingerprint = hashlib.sha256(b"sc-cpe-sample-cert-demo").hexdigest()
    fp_pretty = ":".join(
        fake_fingerprint[i : i + 2].upper() for i in range(0, len(fake_fingerprint), 2)
    )

    html_str = template.render(
        recipient_name="Jane Doe",
        issuer_name="Simply Cyber CPE",
        period_display="March 2026",
        attended_line="during March 2026",
        dates_line=f"First {sample_dates[0]} · Last {sample_dates[-1]} · {sessions_count} sessions",
        cpe_total=f"{cpe_total:g}",
        sessions_count=sessions_count,
        cert_id=cert_id,
        cert_id_display=cert_id[:12],
        public_token=public_token,
        verify_url=verify_url,
        verify_qr_data_uri=qr_svg_data_uri(verify_url),
        issued_at="2026-04-01T00:00:00Z",
        signing_cert_sha256=fp_pretty,
    )

    pdf_path = OUT_DIR / "sample-cert.pdf"
    png_path = OUT_DIR / "sample-cert.png"

    pdf_bytes = HTML(string=html_str, base_url=str(TEMPLATE_DIR)).write_pdf()
    pdf_path.write_bytes(pdf_bytes)

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc.load_page(0)
    pix = page.get_pixmap(matrix=fitz.Matrix(2.5, 2.5), alpha=False)
    pix.save(str(png_path))
    doc.close()

    print(f"wrote {pdf_path.relative_to(ROOT)} ({len(pdf_bytes)} bytes)")
    print(f"wrote {png_path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
