-- Links shared by host/moderators during the Daily Threat Briefing.
-- Poller extracts URLs inline; purge worker enriches with page metadata.

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
