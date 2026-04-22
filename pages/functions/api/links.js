import { json, clientIp, ipHash, rateLimit } from "../_lib.js";

export async function onRequestGet({ env, request }) {
    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, `links:${ipH}`, 120);
    if (!rl.ok) return json(rl.body, rl.status);

    const url = new URL(request.url);
    const dateParam = url.searchParams.get("date");
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "30", 10) || 30, 1), 30);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

    let date = dateParam;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const latest = await env.DB.prepare(`
            SELECT s.scheduled_date
              FROM streams s
             WHERE s.id IN (SELECT stream_id FROM show_links)
               AND s.state IN ('live','complete','flagged')
          ORDER BY s.scheduled_date DESC
             LIMIT 1
        `).first();
        date = latest?.scheduled_date || null;
    }

    if (!date) {
        return json({ date: null, stream: null, links: [], available_dates: [] });
    }

    const stream = await env.DB.prepare(`
        SELECT id, title, yt_video_id
          FROM streams
         WHERE scheduled_date = ?1
           AND state IN ('live','complete','flagged')
         LIMIT 1
    `).bind(date).first();

    let links = [];
    if (stream) {
        const rows = await env.DB.prepare(`
            SELECT url, domain, title, description, author_type,
                   author_name, posted_at
              FROM show_links
             WHERE stream_id = ?1
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

    const datesRs = await env.DB.prepare(`
        SELECT DISTINCT s.scheduled_date
          FROM streams s
         WHERE s.id IN (SELECT stream_id FROM show_links)
           AND s.state IN ('live','complete','flagged')
      ORDER BY s.scheduled_date DESC
         LIMIT 60
    `).all();
    const available_dates = (datesRs.results || []).map(r => r.scheduled_date);

    return json({
        date,
        stream: stream ? { title: stream.title, yt_video_id: stream.yt_video_id } : null,
        links,
        available_dates,
    });
}
