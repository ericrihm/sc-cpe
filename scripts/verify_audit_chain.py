#!/usr/bin/env python3
"""
verify_audit_chain.py — verify the hash-chain integrity of audit_log rows.

Pulls every row from the audit_log table via the D1 HTTP API, sorts by
(ts ASC, id ASC), and walks the chain. For each row after the first it
recomputes the expected prev_hash from the prior row's canonical JSON and
compares against what's stored. Any mismatch — or a row that doesn't match
the expected structural invariants (exactly one genesis row with
prev_hash=NULL, all others non-NULL, no duplicate prev_hash) — is flagged.

Canonical JSON format MUST match the writers:
  pages/functions/_lib.js::canonicalAuditRow
  workers/poller/src/index.js::canonicalAuditRow
  workers/purge/src/index.js::canonicalAuditRow
  services/certs/generate.py::canonical_audit_row
  (array of [id, actor_type, actor_id, action, entity_type, entity_id,
             before_json, after_json, ip_hash, user_agent, ts, prev_hash])

Usage:
    CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... D1_DATABASE_ID=... \\
        python scripts/verify_audit_chain.py

Exit codes:
    0 — chain is intact.
    1 — chain is broken (details printed to stderr).
    2 — precondition error (env vars missing, HTTP failure, etc.).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from typing import Any

import requests

AUDIT_FIELDS = (
    "id", "actor_type", "actor_id", "action",
    "entity_type", "entity_id",
    "before_json", "after_json",
    "ip_hash", "user_agent",
    "ts", "prev_hash",
)


def canonical(row: dict[str, Any]) -> str:
    return json.dumps(
        [row.get(k) for k in AUDIT_FIELDS],
        separators=(",", ":"),
        ensure_ascii=False,
    )


def row_hash(row: dict[str, Any]) -> str:
    return hashlib.sha256(canonical(row).encode("utf-8")).hexdigest()


def require_env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        print(f"missing env var {name}", file=sys.stderr)
        sys.exit(2)
    return v


def fetch_all_rows() -> list[dict[str, Any]]:
    acct = require_env("CLOUDFLARE_ACCOUNT_ID")
    db = require_env("D1_DATABASE_ID")
    token = require_env("CLOUDFLARE_API_TOKEN")
    url = f"https://api.cloudflare.com/client/v4/accounts/{acct}/d1/database/{db}/query"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body = {
        "sql": (
            f"SELECT {', '.join(AUDIT_FIELDS)} FROM audit_log "
            "ORDER BY ts ASC, id ASC"
        ),
        "params": [],
    }
    r = requests.post(url, headers=headers, json=body, timeout=60)
    if r.status_code >= 400:
        print(f"D1 HTTP {r.status_code}: {r.text[:500]}", file=sys.stderr)
        sys.exit(2)
    payload = r.json()
    if not payload.get("success"):
        print(f"D1 errors: {payload.get('errors')}", file=sys.stderr)
        sys.exit(2)
    result = payload.get("result") or []
    if not result:
        return []
    return result[0].get("results") or []


def verify(rows: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    if not rows:
        return errors

    genesis_count = sum(1 for r in rows if r.get("prev_hash") is None)
    if genesis_count > 1:
        errors.append(f"expected exactly 1 genesis row, found {genesis_count}")

    seen_prev: dict[str, str] = {}
    expected_prev: str | None = None  # genesis prev_hash is NULL
    for i, row in enumerate(rows):
        actual_prev = row.get("prev_hash")
        if i == 0:
            if actual_prev is not None:
                errors.append(
                    f"row[0] id={row.get('id')} ts={row.get('ts')} "
                    f"expected genesis (prev_hash=NULL) but got {actual_prev!r}"
                )
        else:
            if actual_prev != expected_prev:
                errors.append(
                    f"row[{i}] id={row.get('id')} ts={row.get('ts')} "
                    f"prev_hash mismatch: stored={actual_prev!r} "
                    f"expected={expected_prev!r}"
                )
            if actual_prev is not None and actual_prev in seen_prev:
                errors.append(
                    f"row[{i}] id={row.get('id')} duplicate prev_hash "
                    f"(also used by id={seen_prev[actual_prev]})"
                )
            if actual_prev is not None:
                seen_prev[actual_prev] = row.get("id") or ""
        expected_prev = row_hash(row)

    return errors


def main() -> int:
    rows = fetch_all_rows()
    print(f"audit_log rows fetched: {len(rows)}")
    if not rows:
        print("empty table — chain is vacuously valid")
        return 0

    errors = verify(rows)
    if errors:
        print(f"CHAIN BROKEN — {len(errors)} issue(s):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    tip = rows[-1]
    print(f"chain OK — tip id={tip.get('id')} ts={tip.get('ts')} "
          f"tip_hash={row_hash(tip)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
