#!/usr/bin/env python3
"""Rescan YouTube chat replays for streams the live poller missed.

Pulls chat replay via chat_downloader (no auth needed), then applies the
same code-matching and attendance-crediting logic the poller uses. Writes
hash-chained audit entries so the chain stays unbroken.

Usage:
  # Rescan all flagged streams with 0 messages from the last 7 days:
  python scripts/rescan_chat.py

  # Rescan a specific video:
  python scripts/rescan_chat.py --video-id J2lEmJCwcoQ

Environment:
  CLOUDFLARE_API_TOKEN   CF API token with D1 edit permission
  CLOUDFLARE_ACCOUNT_ID  CF account ID
  D1_DATABASE_ID         Production D1 database ID (default: from wrangler.toml)

Requires: pip install chat-downloader
"""

import argparse
import hashlib
import json
import os
import re
import secrets
import sys
import time
import datetime as dt
from typing import Any

try:
    from chat_downloader import ChatDownloader
    from chat_downloader.errors import (
        NoChatReplay,
        VideoUnavailable,
        ParsingError,
    )
except ImportError:
    print("ERROR: pip install chat-downloader", file=sys.stderr)
    sys.exit(1)

try:
    import requests
except ImportError:
    print("ERROR: pip install requests", file=sys.stderr)
    sys.exit(1)

CODE_RE = re.compile(
    r"SC-CPE[-{]([0-9A-HJKMNP-TV-Z]{4})-?([0-9A-HJKMNP-TV-Z]{4})\}?", re.I
)
DEFAULT_DB_ID = "28218db6-6f35-4bfb-85cd-abd2881b6049"
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_AUDIT_FIELDS = (
    "id", "actor_type", "actor_id", "action",
    "entity_type", "entity_id",
    "before_json", "after_json",
    "ip_hash", "user_agent",
    "ts", "prev_hash",
)


def new_ulid() -> str:
    ts_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    rand = int.from_bytes(secrets.token_bytes(10), "big")
    n = (ts_ms << 80) | rand
    out = []
    for _ in range(26):
        out.append(CROCKFORD[n & 0x1F])
        n >>= 5
    return "".join(reversed(out))


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def canonical_audit_row(r: dict[str, Any]) -> str:
    return json.dumps(
        [r.get(k) for k in _AUDIT_FIELDS],
        separators=(",", ":"),
        ensure_ascii=False,
    )


class D1Error(RuntimeError):
    pass


class D1Client:
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

    def query(self, sql: str, params: list | None = None) -> list[dict]:
        body = {"sql": sql, "params": params or []}
        resp = self._sess.post(self.url, headers=self.headers, json=body, timeout=30)
        payload = resp.json()
        if resp.status_code >= 400 or not payload.get("success"):
            raise D1Error(f"D1 error {resp.status_code}: {payload.get('errors')}")
        result = payload.get("result") or []
        return result[0].get("results") or [] if result else []

    def execute(self, sql: str, params: list | None = None) -> None:
        self.query(sql, params)


def audit(d1: D1Client, actor_type: str, actor_id: str | None,
          action: str, entity_type: str, entity_id: str,
          before: Any = None, after: Any = None) -> str:
    before_json = json.dumps(before) if before is not None else None
    after_json = json.dumps(after) if after is not None else None
    for attempt in range(5):
        tip = d1.query(
            f"SELECT {', '.join(_AUDIT_FIELDS)} FROM audit_log "
            "ORDER BY ts DESC, id DESC LIMIT 1"
        )
        prev_hash = sha256_hex(canonical_audit_row(tip[0])) if tip else None
        row_id = new_ulid()
        ts = now_iso()
        try:
            d1.execute(
                "INSERT INTO audit_log "
                "(id, actor_type, actor_id, action, entity_type, entity_id, "
                "before_json, after_json, ip_hash, user_agent, ts, prev_hash) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [row_id, actor_type, actor_id, action, entity_type, entity_id,
                 before_json, after_json, None, None, ts, prev_hash],
            )
            return row_id
        except D1Error as e:
            if "UNIQUE" not in str(e).upper():
                raise
            time.sleep(0.01 + secrets.randbelow(40) / 1000.0)
    raise RuntimeError("audit chain contention after 5 attempts")


def load_rule(d1: D1Client) -> dict:
    rows = d1.query("SELECT k, v FROM kv WHERE k LIKE 'rule_version.%'")
    m = {r["k"]: r["v"] for r in rows}
    v = int(m.get("rule_version.current", "1"))
    return {
        "version": v,
        "min_msg_len": int(m.get(f"rule_version.{v}.min_msg_len", "3")),
        "pre_start_grace_min": int(m.get(f"rule_version.{v}.pre_start_grace_min", "15")),
        "cpe_per_day": float(m.get(f"rule_version.{v}.cpe_per_day", "0.5")),
    }


def passes_message_filter(text: str, min_len: int) -> bool:
    if len(text) < min_len:
        return False
    return bool(re.search(r"[\w]", text, re.UNICODE))


def download_chat(video_id: str) -> list[dict]:
    url = f"https://www.youtube.com/watch?v={video_id}"
    chat = ChatDownloader().get_chat(url, message_groups=["messages"])
    messages = []
    for msg in chat:
        messages.append({
            "id": msg.get("message_id", ""),
            "text": msg.get("message", ""),
            "channel_id": msg.get("author", {}).get("id", ""),
            "display_name": msg.get("author", {}).get("name", ""),
            "published_at": msg.get("timestamp"),
            "time_text": msg.get("time_text", ""),
        })
    return messages


def rescan_stream(d1: D1Client, stream: dict, dry_run: bool = False) -> dict:
    video_id = stream["yt_video_id"]
    stream_id = stream["id"]
    actual_start = stream.get("actual_start_at")
    print(f"\n{'='*60}")
    print(f"Rescanning: {video_id} ({stream.get('title', '?')})")
    print(f"  Stream ID: {stream_id}")
    print(f"  Start: {actual_start}")
    print(f"  Current state: {stream['state']}, msgs: {stream['messages_scanned']}")

    try:
        messages = download_chat(video_id)
    except (NoChatReplay, VideoUnavailable, ParsingError) as e:
        print(f"  SKIP: {type(e).__name__}: {e}")
        return {"status": "skip", "reason": str(e)}
    except Exception as e:
        print(f"  ERROR: {e}")
        return {"status": "error", "reason": str(e)}

    print(f"  Downloaded {len(messages)} chat messages")
    if not messages:
        return {"status": "empty", "messages": 0}

    rule = load_rule(d1)

    start_ms = None
    window_open_ms = None
    if actual_start:
        start_ms = int(dt.datetime.fromisoformat(
            actual_start.replace("Z", "+00:00")
        ).timestamp() * 1000)
        window_open_ms = start_ms - rule["pre_start_grace_min"] * 60_000

    # Load users with active verification codes
    code_users = d1.query(
        "SELECT id, verification_code, code_expires_at, state, yt_channel_id "
        "FROM users WHERE verification_code IS NOT NULL AND deleted_at IS NULL"
    )
    code_map = {u["verification_code"]: u for u in code_users}

    # Load active users with linked channels for attendance
    active_users = d1.query(
        "SELECT id, yt_channel_id FROM users "
        "WHERE state = 'active' AND yt_channel_id IS NOT NULL AND deleted_at IS NULL"
    )
    channel_to_user = {u["yt_channel_id"]: u["id"] for u in active_users}

    # Load existing attendance for this stream
    existing_att = d1.query(
        "SELECT user_id FROM attendance WHERE stream_id = ?", [stream_id]
    )
    already_credited = {r["user_id"] for r in existing_att}

    now = dt.datetime.now(dt.timezone.utc)
    now_iso_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    codes_linked = 0
    attendance_credited = 0

    for msg in messages:
        text = msg["text"].strip()
        channel_id = msg["channel_id"]
        msg_ts = msg.get("published_at")
        msg_ms = msg_ts * 1000 if isinstance(msg_ts, (int, float)) else None

        # --- Code matching ---
        match = CODE_RE.search(text)
        if match and channel_id:
            code = (match.group(1) + match.group(2)).upper()
            user = code_map.get(code)
            if user:
                needs_link = (
                    user["state"] == "pending_verification"
                    or (user["state"] == "active" and not user["yt_channel_id"])
                )
                if needs_link:
                    expires = dt.datetime.fromisoformat(
                        user["code_expires_at"].replace("Z", "+00:00")
                    )
                    if expires > now:
                        if window_open_ms and msg_ms and msg_ms < window_open_ms:
                            print(f"  Code {code}: outside window, skipping")
                        elif not dry_run:
                            d1.execute(
                                "UPDATE users SET yt_channel_id = ?, "
                                "yt_display_name_seen = ?, state = 'active', "
                                "verification_code = NULL, "
                                "verified_at = COALESCE(verified_at, ?) "
                                "WHERE id = ?",
                                [channel_id, msg["display_name"],
                                 now_iso_str, user["id"]],
                            )
                            action = ("channel_linked" if user["state"] == "active"
                                      else "user_verified")
                            audit(d1, "rescan", None, action, "user", user["id"],
                                  {"state": user["state"],
                                   "yt_channel_id": user["yt_channel_id"]},
                                  {"state": "active", "yt_channel_id": channel_id,
                                   "stream_id": stream_id})
                            # Also add to channel_to_user for attendance
                            channel_to_user[channel_id] = user["id"]
                            already_credited.discard(user["id"])
                            del code_map[code]
                            codes_linked += 1
                            print(f"  LINKED: {code} -> {msg['display_name']} ({channel_id})")
                    else:
                        print(f"  Code {code}: expired")

        # --- Attendance ---
        if not channel_id or channel_id not in channel_to_user:
            continue
        if not passes_message_filter(text, rule["min_msg_len"]):
            continue
        if window_open_ms and msg_ms and msg_ms < window_open_ms:
            continue

        user_id = channel_to_user[channel_id]
        if user_id in already_credited:
            continue

        msg_sha = sha256_hex(text)
        msg_id = msg.get("id") or f"rescan-{new_ulid()}"

        published_iso = now_iso_str
        if isinstance(msg_ts, (int, float)):
            published_iso = dt.datetime.fromtimestamp(
                msg_ts / 1000 if msg_ts > 1e12 else msg_ts,
                tz=dt.timezone.utc,
            ).strftime("%Y-%m-%dT%H:%M:%SZ")

        if not dry_run:
            try:
                d1.execute(
                    "INSERT OR IGNORE INTO attendance "
                    "(user_id, stream_id, earned_cpe, first_msg_id, first_msg_at, "
                    "first_msg_sha256, first_msg_len, rule_version, source, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'poll', ?)",
                    [user_id, stream_id, rule["cpe_per_day"],
                     msg_id, published_iso, msg_sha, len(text),
                     rule["version"], now_iso_str],
                )
                attendance_credited += 1
                already_credited.add(user_id)
                audit(d1, "rescan", None, "attendance_credited", "user", user_id,
                      None, {"stream_id": stream_id, "earned_cpe": rule["cpe_per_day"],
                             "source": "rescan"})
                print(f"  ATTENDANCE: {user_id} credited {rule['cpe_per_day']} CPE")
            except D1Error:
                pass  # INSERT OR IGNORE handles duplicates

    # Update stream
    if not dry_run and (codes_linked > 0 or attendance_credited > 0 or len(messages) > 0):
        d1.execute(
            "UPDATE streams SET state = 'rescanned', "
            "messages_scanned = ?, distinct_attendees = ? WHERE id = ?",
            [len(messages), attendance_credited + len(already_credited) - attendance_credited,
             stream_id],
        )
        # Simpler: just count total attendance for this stream
        att_count = d1.query(
            "SELECT COUNT(*) as n FROM attendance WHERE stream_id = ?", [stream_id]
        )
        d1.execute(
            "UPDATE streams SET distinct_attendees = ? WHERE id = ?",
            [att_count[0]["n"] if att_count else 0, stream_id],
        )
        audit(d1, "rescan", None, "stream_rescanned", "stream", stream_id,
              None, {"messages": len(messages), "codes_linked": codes_linked,
                     "attendance_credited": attendance_credited})

    result = {
        "status": "ok",
        "messages": len(messages),
        "codes_linked": codes_linked,
        "attendance_credited": attendance_credited,
    }
    print(f"  Result: {result}")
    return result


def main():
    parser = argparse.ArgumentParser(description="Rescan YouTube chat replays")
    parser.add_argument("--video-id", help="Rescan a specific video")
    parser.add_argument("--days", type=int, default=7,
                        help="Look back N days for flagged streams (default 7)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would happen without writing to D1")
    args = parser.parse_args()

    api_token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    db_id = os.environ.get("D1_DATABASE_ID", DEFAULT_DB_ID)

    if not api_token or not account_id:
        env_file = os.path.expanduser("~/.cloudflare/grc-eng.env")
        if os.path.isfile(env_file):
            with open(env_file) as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("export "):
                        line = line[7:]
                    if "=" in line:
                        k, v = line.split("=", 1)
                        v = v.strip('"').strip("'")
                        if k == "CLOUDFLARE_API_TOKEN" and not api_token:
                            api_token = v
                        elif k == "CLOUDFLARE_ACCOUNT_ID" and not account_id:
                            account_id = v

    if not api_token or not account_id:
        print("ERROR: Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID", file=sys.stderr)
        sys.exit(1)

    d1 = D1Client(account_id, db_id, api_token)

    if args.video_id:
        streams = d1.query(
            "SELECT id, yt_video_id, title, actual_start_at, state, "
            "messages_scanned, distinct_attendees FROM streams "
            "WHERE yt_video_id = ?", [args.video_id]
        )
    else:
        cutoff = (dt.datetime.now(dt.timezone.utc)
                  - dt.timedelta(days=args.days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        streams = d1.query(
            "SELECT id, yt_video_id, title, actual_start_at, state, "
            "messages_scanned, distinct_attendees FROM streams "
            "WHERE state IN ('flagged', 'complete') "
            "AND messages_scanned = 0 "
            "AND yt_video_id NOT LIKE 'discord%' "
            "AND yt_video_id NOT LIKE 'TEST%' "
            "AND created_at > ?",
            [cutoff],
        )

    if not streams:
        print("No streams to rescan.")
        return

    print(f"Found {len(streams)} stream(s) to rescan")
    results = []
    for s in streams:
        r = rescan_stream(d1, s, dry_run=args.dry_run)
        results.append({"video_id": s["yt_video_id"], **r})

    print(f"\n{'='*60}")
    print("Summary:")
    total_ok = 0
    total_skip = 0
    for r in results:
        if r["status"] == "ok":
            total_ok += 1
        elif r["status"] == "skip":
            total_skip += 1
        print(f"  {r['video_id']}: {r['status']}"
              + (f" — {r.get('messages',0)} msgs, {r.get('codes_linked',0)} codes, "
                 f"{r.get('attendance_credited',0)} attendance"
                 if r["status"] == "ok" else f" — {r.get('reason','')}"))

    if total_skip == len(results):
        print("\nAll streams skipped. Chat replay may be disabled in YouTube Studio.")
        print("Channel owner: Settings → Community → Defaults → Live chat replay")


if __name__ == "__main__":
    import io
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "buffer"):
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    main()
