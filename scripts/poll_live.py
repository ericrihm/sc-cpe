#!/usr/bin/env python3
"""
Phase A: detect if the Simply Cyber channel is live and stream chat messages
as (channelId, displayName, publishedAt, message) tuples.

Usage:
    export YOUTUBE_API_KEY=...
    export SC_CHANNEL_ID=UCxxxxxxxxxxxxxxxxxx
    python scripts/poll_live.py

To find the channel ID: view-source on any Simply Cyber video page and
search for "channelId" or use https://commentpicker.com/youtube-channel-id.php
with the @SimplyCyber handle.
"""

import os
import sys
import time
import json
import urllib.parse
import urllib.request

API = "https://www.googleapis.com/youtube/v3"


def _get(path, params):
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read())


def find_live_video(channel_id, api_key):
    data = _get("search", {
        "part": "id",
        "channelId": channel_id,
        "eventType": "live",
        "type": "video",
        "key": api_key,
        "maxResults": 1,
    })
    items = data.get("items", [])
    return items[0]["id"]["videoId"] if items else None


def get_live_chat_id(video_id, api_key):
    data = _get("videos", {
        "part": "liveStreamingDetails",
        "id": video_id,
        "key": api_key,
    })
    items = data.get("items", [])
    if not items:
        return None
    return items[0].get("liveStreamingDetails", {}).get("activeLiveChatId")


def poll_chat(live_chat_id, api_key):
    page_token = None
    quota_estimate = 0
    message_count = 0
    unique_channels = set()
    while True:
        params = {
            "liveChatId": live_chat_id,
            "part": "snippet,authorDetails",
            "key": api_key,
            "maxResults": 2000,
        }
        if page_token:
            params["pageToken"] = page_token
        try:
            data = _get("liveChatMessages", params)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            print(f"[ERROR] HTTP {e.code}: {body}", file=sys.stderr)
            if e.code in (403, 404):
                print(f"[EXIT] chat closed or quota exhausted", file=sys.stderr)
                break
            time.sleep(5)
            continue

        quota_estimate += 5
        for item in data.get("items", []):
            s = item.get("snippet", {})
            a = item.get("authorDetails", {})
            cid = a.get("channelId", "?")
            name = a.get("displayName", "?")
            ts = s.get("publishedAt", "?")
            text = s.get("displayMessage", "")
            unique_channels.add(cid)
            message_count += 1
            print(f"{ts}\t{cid}\t{name}\t{text}", flush=True)

        page_token = data.get("nextPageToken")
        interval_ms = int(data.get("pollingIntervalMillis", 5000))
        print(
            f"[STATS] messages={message_count} "
            f"unique_channels={len(unique_channels)} "
            f"quota_units~={quota_estimate} "
            f"next_poll_ms={interval_ms}",
            file=sys.stderr,
        )
        if not page_token:
            print("[EXIT] stream ended (no nextPageToken)", file=sys.stderr)
            break
        time.sleep(interval_ms / 1000)


def main():
    api_key = os.environ.get("YOUTUBE_API_KEY")
    channel_id = os.environ.get("SC_CHANNEL_ID")
    if not api_key or not channel_id:
        print("set YOUTUBE_API_KEY and SC_CHANNEL_ID env vars", file=sys.stderr)
        sys.exit(2)

    print(f"[INFO] checking channel {channel_id} for live broadcast...", file=sys.stderr)
    video_id = find_live_video(channel_id, api_key)
    if not video_id:
        print("[INFO] no live broadcast right now", file=sys.stderr)
        sys.exit(0)

    print(f"[INFO] live video: https://youtu.be/{video_id}", file=sys.stderr)
    live_chat_id = get_live_chat_id(video_id, api_key)
    if not live_chat_id:
        print("[ERROR] video is live but has no activeLiveChatId", file=sys.stderr)
        sys.exit(1)

    print(f"[INFO] liveChatId={live_chat_id}", file=sys.stderr)
    poll_chat(live_chat_id, api_key)


if __name__ == "__main__":
    main()
