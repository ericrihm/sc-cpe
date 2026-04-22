# Show Links Archive — Design Spec

**Date:** 2026-04-22
**Requested by:** Gerry (Simply Cyber)
**Status:** Approved

## Summary

A public page that archives all links shared by the host and moderators during the Daily Threat Briefing livestream, organized by show date. Links are extracted inline by the poller, enriched with page titles/descriptions asynchronously by the purge worker, and served via a new public API endpoint.

## Scope

**MVP (this spec):**
- Extract URLs from owner + moderator chat messages in the poller
- Persist to a new `show_links` D1 table
- Enrich with page title + og:description via the purge worker's daily run
- New public API endpoint `GET /api/links`
- New public page `links.html` with date-based navigation

**Future (out of scope):**
- Viewer-submitted links (author_type = 'viewer') — schema supports it, filter change only
- Search/filter across all dates
- Domain-based grouping or icons

## Database Schema

Migration `005_show_links.sql`:

```sql
CREATE TABLE show_links (
  id            TEXT PRIMARY KEY,
  stream_id     TEXT NOT NULL REFERENCES streams(id),
  url           TEXT NOT NULL,
  domain        TEXT NOT NULL,
  title         TEXT,
  description   TEXT,
  author_type   TEXT NOT NULL DEFAULT 'owner',
  author_name   TEXT NOT NULL,
  yt_channel_id TEXT NOT NULL,
  yt_message_id TEXT NOT NULL,
  posted_at     TEXT NOT NULL,
  enriched_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

  UNIQUE(stream_id, url)
);

CREATE INDEX idx_show_links_stream ON show_links(stream_id);
CREATE INDEX idx_show_links_enriched ON show_links(enriched_at) WHERE enriched_at IS NULL;
```

- `UNIQUE(stream_id, url)` deduplicates the same link posted multiple times per stream.
- `author_type` is app-enforced: `'owner'` | `'moderator'` (MVP), `'viewer'` (future).
- `domain` is pre-extracted for frontend display grouping.
- `enriched_at` is set even on fetch failure to prevent infinite retry.

## Poller Changes

In `workers/poller/src/index.js`, after the existing message processing loop:

1. For each message where `isOwner === true` or `isModerator === true`:
2. Extract URLs via regex: `https?://[^\s<>"')\]]+`
3. For each URL:
   - Skip if `new URL(url)` throws (malformed)
   - Extract `domain` via `new URL(url).hostname`
   - `INSERT OR IGNORE INTO show_links` with ULID, stream_id, url, domain, author metadata, posted_at
4. Batch with existing D1 writes — no new round trips.

No outbound fetches. No title resolution. Poller stays fast.

## Enrichment in Purge Worker

New block in `workers/purge/src/index.js`, runs during the daily 09:00 UTC execution:

1. `SELECT id, url FROM show_links WHERE enriched_at IS NULL LIMIT 50`
2. For each row:
   - `fetch(url)` with 5-second timeout
   - Parse HTML for `og:title` (preferred) or `<title>`, and `og:description`
   - `UPDATE show_links SET title = ?, description = ?, enriched_at = ? WHERE id = ?`
3. On fetch failure: set `enriched_at = now`, leave `title` NULL. No infinite retries.
4. Write heartbeat row for `link_enrichment`.

Budget: 50 rows per run. Typical show produces 5-15 links.

Add `link_enrichment: 86400` to `EXPECTED_CADENCE_S` in both:
- `pages/functions/_heartbeat.js`
- `workers/purge/src/index.js`

No audit log entries for enrichment — metadata decoration, not a state change.

## API Endpoint

New file: `pages/functions/api/links.js`

**`GET /api/links`**
- Public, no auth
- Rate-limited: 120 req/hr per IP
- Query params:
  - `date` (YYYY-MM-DD) — optional, defaults to most recent stream with links
  - `limit` (int) — optional, max 30, default 30
  - `offset` (int) — optional, default 0

**Response:**
```json
{
  "date": "2026-04-22",
  "stream": {
    "title": "Daily Threat Briefing — April 22, 2026",
    "yt_video_id": "dQw4w9WgXcQ"
  },
  "links": [
    {
      "url": "https://www.cisa.gov/news/...",
      "domain": "www.cisa.gov",
      "title": "CISA Warns of Critical Vulnerability in...",
      "description": "The Cybersecurity and Infrastructure...",
      "author_type": "owner",
      "author_name": "Gerald Auger",
      "posted_at": "2026-04-22T12:34:56Z"
    }
  ],
  "available_dates": ["2026-04-22", "2026-04-21", "2026-04-18"]
}
```

**SQL:**
- Links query: join `show_links` on `streams` where `streams.scheduled_date = ?` and `streams.state IN ('live','complete')`, ordered by `posted_at ASC`.
- Available dates: `SELECT DISTINCT s.scheduled_date FROM streams s WHERE s.id IN (SELECT stream_id FROM show_links) ORDER BY s.scheduled_date DESC LIMIT 60`.

## Frontend

New files: `pages/links.html`, `pages/links.js`, `pages/links.css`

**Layout:**
- Header: "Show Links Archive" title + subtitle
- Date navigator: left/right arrows stepping through `available_dates`, current date displayed
- Link list: each link as a card showing:
  - Domain pill (e.g., `cisa.gov`)
  - Title (bold, clickable, opens in new tab) — falls back to raw URL if title is NULL
  - Description (truncated ~2 lines, if present)
  - Author label ("Host" / "Moderator") + name
  - Time posted
- Empty state: "No links for this date"
- Nav links to leaderboard and other pages

**Characteristics:**
- No auth, no tokens, no localStorage
- Deep-linkable: `links.html?date=2026-04-22`
- CSP compliant: external JS/CSS only
- `available_dates` from API drives the date navigator client-side

**Nav integration:** Add "Links" entry to nav on `leaderboard.html` and `badge.html`.

## Deployment

**Migration first:** Apply `005_show_links.sql` to D1 before code deploy.

**Deploy order (automatic via deploy-prod.yml):**
1. Migration 005 via `wrangler d1 execute`
2. Poller worker (starts capturing links)
3. Purge worker (starts enriching)
4. Pages (API + frontend go live)

**No backfill.** Archive starts from first show after deploy. Links from past streams in the 7-day R2 window are not worth the backfill complexity.

## Files Touched

| File | Change |
|------|--------|
| `db/migrations/005_show_links.sql` | New — migration |
| `db/schema.sql` | Add `show_links` table definition |
| `workers/poller/src/index.js` | URL extraction from owner/mod messages |
| `workers/purge/src/index.js` | Enrichment block + heartbeat |
| `pages/functions/_heartbeat.js` | Add `link_enrichment` cadence |
| `pages/functions/api/links.js` | New — API endpoint |
| `pages/links.html` | New — public page |
| `pages/links.js` | New — page JS |
| `pages/links.css` | New — page CSS |
| `pages/leaderboard.html` | Add nav link |
| `pages/badge.html` | Add nav link |

## Future Expansion

- **Viewer links:** Change poller filter to include all messages (remove isOwner/isModerator gate). `author_type = 'viewer'` rows appear. Frontend can filter/tab by author_type.
- **Search:** Add `GET /api/links?q=...` with `LIKE` on title/url/description. Add search bar to page.
- **Domain grouping:** Frontend groups by `domain` column, optionally with favicon fetch.
