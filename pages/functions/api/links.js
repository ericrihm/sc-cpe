import { json, clientIp, ipHash, rateLimit } from "../_lib.js";

export async function onRequestGet({ env, request }) {
    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, `links:${ipH}`, 120);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    const url = new URL(request.url);
    const dateParam = url.searchParams.get("date");
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "30", 10) || 30, 1), 30);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

    const countsRs = await env.DB.prepare(`
        SELECT s.scheduled_date,
               COUNT(CASE WHEN sl.author_type IN ('owner','moderator') THEN 1 END) AS cnt
          FROM streams s
          LEFT JOIN show_links sl ON sl.stream_id = s.id
         WHERE s.state IN ('live','complete','flagged','rescanned')
      GROUP BY s.scheduled_date
      ORDER BY s.scheduled_date DESC
         LIMIT 90
    `).all();
    const countsRows = countsRs.results || [];

    const available_dates = countsRows.map(r => r.scheduled_date);
    const date_link_counts = {};
    for (const r of countsRows) {
        date_link_counts[r.scheduled_date] = r.cnt;
    }

    let date = dateParam;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const firstWithLinks = countsRows.find(r => r.cnt > 0);
        date = firstWithLinks?.scheduled_date || null;
    }

    if (!date) {
        return json({ date: null, stream: null, links: [], available_dates: [], date_link_counts: {} });
    }

    const stream = await env.DB.prepare(`
        SELECT id, title, yt_video_id
          FROM streams
         WHERE scheduled_date = ?1
           AND state IN ('live','complete','flagged','rescanned')
         LIMIT 1
    `).bind(date).first();

    let links = [];
    if (stream) {
        const rows = await env.DB.prepare(`
            SELECT url, domain, title, description, author_type,
                   author_name, posted_at
              FROM show_links
             WHERE stream_id = ?1
               AND author_type IN ('owner','moderator')
          ORDER BY posted_at ASC
             LIMIT ?2 OFFSET ?3
        `).bind(stream.id, limit, offset).all();
        links = (rows.results || []).map(r => ({
            url: r.url,
            domain: r.domain,
            title: r.title,
            description: r.description,
            author_type: r.author_type,
            author_name: r.author_name,
            posted_at: r.posted_at,
        }));
    }

    return json({
        date,
        stream: stream ? { title: stream.title, yt_video_id: stream.yt_video_id } : null,
        links,
        available_dates,
        date_link_counts,
    });
}
