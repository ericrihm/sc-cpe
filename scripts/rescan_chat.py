#!/usr/bin/env python3
"""Rescan chat for streams the live poller missed.

Two modes:
  --discord   Read Discord #live-chat channel (primary — no YouTube dependency)
  --youtube   Read YouTube chat replay via chat_downloader (fallback)

Discord mode uses the Discord HTTP API with a user or bot token.
YouTube mode requires chat replay to be enabled on the channel.

Usage:
  # Discord rescan — all flagged streams from the last 7 days:
  python scripts/rescan_chat.py --discord

  # Discord rescan — specific date:
  python scripts/rescan_chat.py --discord --date 2026-04-22

  # YouTube rescan (fallback):
  python scripts/rescan_chat.py --youtube --video-id J2lEmJCwcoQ

Environment:
  CLOUDFLARE_API_TOKEN   CF API token with D1 edit permission
  CLOUDFLARE_ACCOUNT_ID  CF account ID
  D1_DATABASE_ID         Production D1 database ID
  DISCORD_TOKEN          Discord user or bot token
  DISCORD_CHANNEL_ID     Discord #live-chat channel ID

Requires: pip install requests (+ chat-downloader for --youtube mode)
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
    import requests
except ImportError:
    print("ERROR: pip install requests", file=sys.stderr)
    sys.exit(1)

CODE_RE = re.compile(
    r"SC-CPE[-{]([0-9A-HJKMNP-TV-Z]{4})-?([0-9A-HJKMNP-TV-Z]{4})\}?", re.I
)
RESTREAM_RE = re.compile(r"^\[YouTube:\s*(@?\S+)\]\s*(.*)", re.DOTALL)
RESTREAM_BOT_ID = "491614535812120596"
DEFAULT_DB_ID = "28218db6-6f35-4bfb-85cd-abd2881b6049"
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
DISCORD_EPOCH_MS = 1420070400000
_AUDIT_FIELDS = (
    "id", "actor_type", "actor_id", "action",
    "entity_type", "entity_id",
    "before_json", "after_json",
    "ip_hash", "user_agent",
    "ts", "prev_hash",
)


# ── Shared utilities ────────────────────────────────────────────────────

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


def iso_to_ms(iso: str) -> int:
    return int(dt.datetime.fromisoformat(
        iso.replace("Z", "+00:00")
    ).timestamp() * 1000)


_discord_col_cache: bool | None = None

def _has_discord_column(d1: D1Client) -> bool:
    global _discord_col_cache
    if _discord_col_cache is not None:
        return _discord_col_cache
    try:
        d1.query("SELECT discord_user_id FROM users LIMIT 0")
        _discord_col_cache = True
    except D1Error:
        _discord_col_cache = False
    return _discord_col_cache


def passes_message_filter(text: str, min_len: int) -> bool:
    if len(text) < min_len:
        return False
    return bool(re.search(r"[\w]", text, re.UNICODE))


# ── D1 client ───────────────────────────────────────────────────────────

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


# ── Discord API ─────────────────────────────────────────────────────────

def snowflake_from_dt(d: dt.datetime) -> str:
    ms = int(d.timestamp() * 1000) - DISCORD_EPOCH_MS
    return str(ms << 22)


def snowflake_to_dt(sf: str) -> dt.datetime:
    ms = (int(sf) >> 22) + DISCORD_EPOCH_MS
    return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc)


def discord_get(sess: requests.Session, path: str, token: str) -> Any:
    headers = {"Authorization": token, "Content-Type": "application/json"}
    for attempt in range(5):
        resp = sess.get(f"https://discord.com/api/v10{path}",
                        headers=headers, timeout=15)
        if resp.status_code == 429:
            retry = resp.json().get("retry_after", 5)
            print(f"  [rate-limited] waiting {retry}s...")
            time.sleep(retry + 0.5)
            continue
        if resp.status_code >= 400:
            raise RuntimeError(f"Discord {resp.status_code}: {resp.text[:200]}")
        return resp.json()
    raise RuntimeError("Discord rate limit exceeded after 5 retries")


def download_discord_chat(sess: requests.Session, token: str,
                          channel_id: str,
                          window_start: dt.datetime,
                          window_end: dt.datetime) -> list[dict]:
    after_sf = snowflake_from_dt(window_start)
    end_sf = int(snowflake_from_dt(window_end))
    messages = []
    while True:
        path = (f"/channels/{channel_id}/messages"
                f"?after={after_sf}&limit=100")
        batch = discord_get(sess, path, token)
        if not batch:
            break
        batch.sort(key=lambda m: int(m["id"]))
        for m in batch:
            if int(m["id"]) > end_sf:
                return messages
            content = m.get("content", "")
            ts_ms = int(
                dt.datetime.fromisoformat(m["timestamp"]).timestamp() * 1000
            )
            restream = RESTREAM_RE.match(content)
            if m["author"]["id"] == RESTREAM_BOT_ID and restream:
                yt_handle = restream.group(1)
                actual_text = restream.group(2)
                messages.append({
                    "id": f"discord:{m['id']}",
                    "text": actual_text,
                    "channel_id": yt_handle,
                    "display_name": yt_handle,
                    "published_at": ts_ms,
                    "source": "restream",
                })
            else:
                messages.append({
                    "id": f"discord:{m['id']}",
                    "text": content,
                    "channel_id": m["author"]["id"],
                    "display_name": (m["author"].get("global_name")
                                     or m["author"].get("username", "?")),
                    "published_at": ts_ms,
                    "source": "discord",
                })
        after_sf = batch[-1]["id"]
        time.sleep(0.5)
    return messages


# ── YouTube chat replay ─────────────────────────────────────────────────

def download_youtube_chat(video_id: str) -> list[dict]:
    try:
        from chat_downloader import ChatDownloader
        from chat_downloader.errors import NoChatReplay, VideoUnavailable, ParsingError
    except ImportError:
        print("ERROR: pip install chat-downloader (needed for --youtube mode)",
              file=sys.stderr)
        sys.exit(1)

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
            "source": "youtube",
        })
    return messages


# ── Core rescan logic ───────────────────────────────────────────────────

def rescan_stream(d1: D1Client, stream: dict, messages: list[dict],
                  dry_run: bool = False, source: str = "youtube") -> dict:
    stream_id = stream["id"]
    actual_start = stream.get("actual_start_at")

    rule = load_rule(d1)

    window_open_ms = None
    if actual_start:
        start_ms = iso_to_ms(actual_start)
        window_open_ms = start_ms - rule["pre_start_grace_min"] * 60_000

    has_discord_col = _has_discord_column(d1)

    if has_discord_col:
        code_users = d1.query(
            "SELECT id, verification_code, code_expires_at, state, "
            "yt_channel_id, discord_user_id "
            "FROM users WHERE verification_code IS NOT NULL AND deleted_at IS NULL"
        )
    else:
        code_users = d1.query(
            "SELECT id, verification_code, code_expires_at, state, yt_channel_id "
            "FROM users WHERE verification_code IS NOT NULL AND deleted_at IS NULL"
        )
    code_map = {u["verification_code"]: u for u in code_users}

    active_users = d1.query(
        "SELECT id, yt_channel_id, yt_display_name_seen FROM users "
        "WHERE state = 'active' AND deleted_at IS NULL"
    )
    yt_channel_to_user = {u["yt_channel_id"]: u["id"]
                          for u in active_users if u["yt_channel_id"]}
    yt_name_to_user = {}
    for u in active_users:
        name = u.get("yt_display_name_seen")
        if name:
            yt_name_to_user[name] = u["id"]
            yt_name_to_user[name.lstrip("@")] = u["id"]
            if not name.startswith("@"):
                yt_name_to_user[f"@{name}"] = u["id"]

    discord_to_user: dict[str, str] = {}
    if source == "discord" and has_discord_col:
        discord_users = d1.query(
            "SELECT id, discord_user_id FROM users "
            "WHERE state = 'active' AND discord_user_id IS NOT NULL "
            "AND deleted_at IS NULL"
        )
        discord_to_user = {u["discord_user_id"]: u["id"]
                           for u in discord_users}

    existing_att = d1.query(
        "SELECT user_id FROM attendance WHERE stream_id = ?", [stream_id]
    )
    already_credited = {r["user_id"] for r in existing_att}

    now = dt.datetime.now(dt.timezone.utc)
    now_iso_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    codes_linked = 0
    attendance_credited = 0

    def resolve_user(msg: dict) -> str | None:
        """Map a message to a user_id based on its source."""
        ms = msg.get("source", source)
        author = msg["channel_id"]
        if ms == "restream":
            return (yt_name_to_user.get(author)
                    or yt_name_to_user.get(author.lstrip("@")))
        if ms == "discord":
            return discord_to_user.get(author)
        return yt_channel_to_user.get(author)

    for msg in messages:
        text = msg["text"].strip()
        author_id = msg["channel_id"]
        msg_source = msg.get("source", source)
        msg_ms = msg.get("published_at")
        if isinstance(msg_ms, (int, float)) and msg_ms < 1e12:
            msg_ms = msg_ms * 1000

        # --- Code matching ---
        match = CODE_RE.search(text)
        if match and author_id:
            code = (match.group(1) + match.group(2)).upper()
            user = code_map.get(code)
            if user:
                needs_link = (
                    user["state"] == "pending_verification"
                    or (user["state"] == "active" and not user.get("yt_channel_id")
                        and not user.get("discord_user_id"))
                )
                if needs_link:
                    expires = dt.datetime.fromisoformat(
                        user["code_expires_at"].replace("Z", "+00:00")
                    )
                    if expires > now:
                        if window_open_ms and msg_ms and msg_ms < window_open_ms:
                            print(f"  Code {code}: outside window, skipping")
                        elif not dry_run:
                            if msg_source == "restream":
                                d1.execute(
                                    "UPDATE users SET "
                                    "yt_display_name_seen = ?, state = 'active', "
                                    "verification_code = NULL, "
                                    "verified_at = COALESCE(verified_at, ?) "
                                    "WHERE id = ?",
                                    [author_id, now_iso_str, user["id"]],
                                )
                            elif msg_source == "discord" and has_discord_col:
                                d1.execute(
                                    "UPDATE users SET discord_user_id = ?, "
                                    "yt_display_name_seen = ?, state = 'active', "
                                    "verification_code = NULL, "
                                    "verified_at = COALESCE(verified_at, ?) "
                                    "WHERE id = ?",
                                    [author_id, msg["display_name"],
                                     now_iso_str, user["id"]],
                                )
                            else:
                                d1.execute(
                                    "UPDATE users SET yt_channel_id = ?, "
                                    "yt_display_name_seen = ?, state = 'active', "
                                    "verification_code = NULL, "
                                    "verified_at = COALESCE(verified_at, ?) "
                                    "WHERE id = ?",
                                    [author_id, msg["display_name"],
                                     now_iso_str, user["id"]],
                                )
                            action = ("channel_linked" if user["state"] == "active"
                                      else "user_verified")
                            audit(d1, "cron", None, action, "user", user["id"],
                                  {"state": user["state"]},
                                  {"state": "active",
                                   "yt_handle" if msg_source == "restream"
                                   else "yt_channel_id": author_id,
                                   "stream_id": stream_id,
                                   "source": msg_source})
                            yt_name_to_user[author_id] = user["id"]
                            already_credited.discard(user["id"])
                            del code_map[code]
                            codes_linked += 1
                            print(f"  LINKED: {code} -> {msg['display_name']} ({author_id})")
                    else:
                        print(f"  Code {code}: expired")

        # --- Attendance ---
        user_id = resolve_user(msg)
        if not user_id:
            continue
        if not passes_message_filter(text, rule["min_msg_len"]):
            continue
        if window_open_ms and msg_ms and msg_ms < window_open_ms:
            continue
        if user_id in already_credited:
            continue

        msg_sha = sha256_hex(text)
        msg_id = msg.get("id") or f"rescan-{new_ulid()}"

        published_iso = now_iso_str
        if isinstance(msg_ms, (int, float)):
            published_iso = dt.datetime.fromtimestamp(
                msg_ms / 1000, tz=dt.timezone.utc,
            ).strftime("%Y-%m-%dT%H:%M:%SZ")

        if dry_run:
            attendance_credited += 1
            already_credited.add(user_id)
            print(f"  [DRY-RUN] ATTENDANCE: {user_id} would get "
                  f"{rule['cpe_per_day']} CPE (via {msg.get('source', source)}, "
                  f"name={msg.get('display_name')})")
        else:
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
                audit(d1, "cron", None, "attendance_credited", "user", user_id,
                      None, {"stream_id": stream_id,
                             "earned_cpe": rule["cpe_per_day"],
                             "source": f"rescan_{source}"})
                print(f"  ATTENDANCE: {user_id} credited {rule['cpe_per_day']} CPE")
            except D1Error:
                pass

    if not dry_run and (codes_linked > 0 or attendance_credited > 0 or len(messages) > 0):
        d1.execute(
            "UPDATE streams SET state = 'rescanned', messages_scanned = ? WHERE id = ?",
            [len(messages), stream_id],
        )
        att_count = d1.query(
            "SELECT COUNT(*) as n FROM attendance WHERE stream_id = ?", [stream_id]
        )
        d1.execute(
            "UPDATE streams SET distinct_attendees = ? WHERE id = ?",
            [att_count[0]["n"] if att_count else 0, stream_id],
        )
        audit(d1, "cron", None, "stream_rescanned", "stream", stream_id,
              None, {"messages": len(messages), "codes_linked": codes_linked,
                     "attendance_credited": attendance_credited,
                     "source": source})

    result = {
        "status": "ok",
        "messages": len(messages),
        "codes_linked": codes_linked,
        "attendance_credited": attendance_credited,
    }
    print(f"  Result: {result}")
    return result


# ── Discord rescan entry point ──────────────────────────────────────────

def rescan_discord(d1: D1Client, discord_token: str, channel_id: str,
                   streams: list[dict], dry_run: bool = False) -> list[dict]:
    sess = requests.Session()
    rule = load_rule(d1)
    grace_min = rule["pre_start_grace_min"]
    results = []

    for stream in streams:
        video_id = stream["yt_video_id"]
        stream_id = stream["id"]
        actual_start = stream.get("actual_start_at")
        scheduled = stream.get("scheduled_date")

        print(f"\n{'='*60}")
        print(f"Rescanning via Discord: {video_id}")
        print(f"  Stream ID: {stream_id}")
        print(f"  Date: {scheduled}, Start: {actual_start}")
        print(f"  Current state: {stream['state']}, msgs: {stream['messages_scanned']}")

        if actual_start:
            start = dt.datetime.fromisoformat(actual_start.replace("Z", "+00:00"))
        elif scheduled:
            y, m, d = map(int, scheduled.split("-"))
            start = dt.datetime(y, m, d, 12, 0, tzinfo=dt.timezone.utc)
        else:
            print("  SKIP: no start time or date")
            results.append({"video_id": video_id, "status": "skip",
                            "reason": "no start time"})
            continue

        window_start = start - dt.timedelta(minutes=grace_min)
        window_end = start + dt.timedelta(hours=3, minutes=grace_min)
        print(f"  Window: {window_start.strftime('%H:%M')} – "
              f"{window_end.strftime('%H:%M')} UTC")

        try:
            messages = download_discord_chat(
                sess, discord_token, channel_id, window_start, window_end)
        except Exception as e:
            print(f"  ERROR: {e}")
            results.append({"video_id": video_id, "status": "error",
                            "reason": str(e)})
            continue

        print(f"  Downloaded {len(messages)} Discord messages")
        if not messages:
            results.append({"video_id": video_id, "status": "empty",
                            "messages": 0})
            continue

        r = rescan_stream(d1, stream, messages, dry_run=dry_run, source="discord")
        results.append({"video_id": video_id, **r})

    return results


# ── YouTube rescan entry point ──────────────────────────────────────────

def rescan_youtube(d1: D1Client, streams: list[dict],
                   dry_run: bool = False) -> list[dict]:
    try:
        from chat_downloader.errors import NoChatReplay, VideoUnavailable, ParsingError
    except ImportError:
        print("ERROR: pip install chat-downloader", file=sys.stderr)
        sys.exit(1)

    results = []
    for stream in streams:
        video_id = stream["yt_video_id"]
        print(f"\n{'='*60}")
        print(f"Rescanning via YouTube: {video_id} ({stream.get('title', '?')})")
        print(f"  Stream ID: {stream['id']}")
        print(f"  Start: {stream.get('actual_start_at')}")
        print(f"  Current state: {stream['state']}, msgs: {stream['messages_scanned']}")

        try:
            messages = download_youtube_chat(video_id)
        except (NoChatReplay, VideoUnavailable, ParsingError) as e:
            print(f"  SKIP: {type(e).__name__}: {e}")
            results.append({"video_id": video_id, "status": "skip",
                            "reason": str(e)})
            continue
        except Exception as e:
            print(f"  ERROR: {e}")
            results.append({"video_id": video_id, "status": "error",
                            "reason": str(e)})
            continue

        print(f"  Downloaded {len(messages)} chat messages")
        if not messages:
            results.append({"video_id": video_id, "status": "empty",
                            "messages": 0})
            continue

        r = rescan_stream(d1, stream, messages, dry_run=dry_run, source="youtube")
        results.append({"video_id": video_id, **r})

    return results


# ── Main ────────────────────────────────────────────────────────────────

def load_env():
    api_token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
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
    return api_token, account_id


def load_discord_token() -> str:
    token = os.environ.get("DISCORD_TOKEN", "")
    if not token:
        token_file = os.path.expanduser("~/.discord-token")
        if os.path.isfile(token_file):
            with open(token_file) as f:
                token = f.read().strip()
    return token


def main():
    parser = argparse.ArgumentParser(
        description="Rescan chat for missed attendance (Discord or YouTube)")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--discord", action="store_true",
                      help="Rescan from Discord #live-chat channel")
    mode.add_argument("--youtube", action="store_true",
                      help="Rescan from YouTube chat replay")
    parser.add_argument("--video-id", help="Rescan a specific YouTube video")
    parser.add_argument("--date", help="Rescan a specific date (YYYY-MM-DD)")
    parser.add_argument("--days", type=int, default=7,
                        help="Look back N days for flagged streams (default 7)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would happen without writing to D1")
    args = parser.parse_args()

    api_token, account_id = load_env()
    db_id = os.environ.get("D1_DATABASE_ID", DEFAULT_DB_ID)

    if not api_token or not account_id:
        print("ERROR: Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID",
              file=sys.stderr)
        sys.exit(1)

    d1 = D1Client(account_id, db_id, api_token)

    if args.discord:
        discord_token = load_discord_token()
        channel_id = os.environ.get("DISCORD_CHANNEL_ID", "")
        if not discord_token:
            print("ERROR: Set DISCORD_TOKEN or create ~/.discord-token",
                  file=sys.stderr)
            sys.exit(1)
        if not channel_id:
            print("ERROR: Set DISCORD_CHANNEL_ID", file=sys.stderr)
            sys.exit(1)

        if args.date:
            streams = d1.query(
                "SELECT id, yt_video_id, title, actual_start_at, scheduled_date, "
                "state, messages_scanned FROM streams "
                "WHERE scheduled_date = ? AND yt_video_id NOT LIKE 'discord%'",
                [args.date],
            )
            if not streams:
                streams = d1.query(
                    "SELECT id, yt_video_id, title, actual_start_at, "
                    "scheduled_date, state, messages_scanned FROM streams "
                    "WHERE yt_video_id = ?",
                    [f"discord-backfill-{args.date}"],
                )
        elif args.video_id:
            streams = d1.query(
                "SELECT id, yt_video_id, title, actual_start_at, scheduled_date, "
                "state, messages_scanned FROM streams WHERE yt_video_id = ?",
                [args.video_id],
            )
        else:
            cutoff = (dt.datetime.now(dt.timezone.utc)
                      - dt.timedelta(days=args.days)).strftime("%Y-%m-%dT%H:%M:%SZ")
            streams = d1.query(
                "SELECT id, yt_video_id, title, actual_start_at, scheduled_date, "
                "state, messages_scanned FROM streams "
                "WHERE state IN ('flagged', 'complete') "
                "AND messages_scanned = 0 "
                "AND yt_video_id NOT LIKE 'TEST%' "
                "AND created_at > ?",
                [cutoff],
            )

        if not streams:
            print("No streams to rescan.")
            return

        print(f"Found {len(streams)} stream(s) to rescan via Discord")
        results = rescan_discord(d1, discord_token, channel_id, streams,
                                 dry_run=args.dry_run)

    else:  # --youtube
        if args.video_id:
            streams = d1.query(
                "SELECT id, yt_video_id, title, actual_start_at, scheduled_date, "
                "state, messages_scanned FROM streams WHERE yt_video_id = ?",
                [args.video_id],
            )
        else:
            cutoff = (dt.datetime.now(dt.timezone.utc)
                      - dt.timedelta(days=args.days)).strftime("%Y-%m-%dT%H:%M:%SZ")
            streams = d1.query(
                "SELECT id, yt_video_id, title, actual_start_at, scheduled_date, "
                "state, messages_scanned FROM streams "
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

        print(f"Found {len(streams)} stream(s) to rescan via YouTube")
        results = rescan_youtube(d1, streams, dry_run=args.dry_run)

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

    if total_skip == len(results) and args.youtube:
        print("\nAll streams skipped. Chat replay may be disabled in YouTube Studio.")
        print("Channel owner: Settings → Community → Defaults → Live chat replay")


if __name__ == "__main__":
    import io
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                                      errors="replace")
    if hasattr(sys.stderr, "buffer"):
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8",
                                      errors="replace")
    main()
