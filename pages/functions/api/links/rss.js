import { json, clientIp, ipHash, rateLimit, escapeHtml } from "../../_lib.js";

function rfc2822(dateStr) {
    return new Date(dateStr + "T12:00:00Z").toUTCString();
}

export async function onRequestGet({ env, request }) {
    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, `rss:${ipH}`, 60);
    if (!rl.ok) return json(rl.body, rl.status);

    const origin = new URL(request.url).origin;

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
    const datesWithLinks = (countsRs.results || []).filter(r => r.cnt > 0).slice(0, 30);

    let items = "";
    for (const row of datesWithLinks) {
        const stream = await env.DB.prepare(`
            SELECT id, title, yt_video_id
              FROM streams
             WHERE scheduled_date = ?1
               AND state IN ('live','complete','flagged','rescanned')
             LIMIT 1
        `).bind(row.scheduled_date).first();
        if (!stream) continue;

        const linksRs = await env.DB.prepare(`
            SELECT url, domain, title, author_type, author_name
              FROM show_links
             WHERE stream_id = ?1
               AND author_type IN ('owner','moderator')
          ORDER BY posted_at ASC
        `).bind(stream.id).all();
        const links = linksRs.results || [];
        if (!links.length) continue;

        const pageUrl = `${origin}/links.html?date=${row.scheduled_date}`;
        const titleDate = new Date(row.scheduled_date + "T12:00:00Z")
            .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
        const itemTitle = `Daily Threat Briefing Links — ${titleDate}`;

        let desc = "<ul>";
        for (const l of links) {
            const label = l.title ? escapeHtml(l.title) : escapeHtml(l.url);
            desc += `<li><a href="${escapeHtml(l.url)}">${label}</a> (${escapeHtml(l.domain)})</li>`;
        }
        desc += "</ul>";

        items += `
    <item>
      <title>${escapeHtml(itemTitle)}</title>
      <link>${escapeHtml(pageUrl)}</link>
      <guid isPermaLink="true">${escapeHtml(pageUrl)}</guid>
      <pubDate>${rfc2822(row.scheduled_date)}</pubDate>
      <description><![CDATA[${desc}]]></description>
    </item>`;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Simply Cyber Daily Threat Briefing — Links</title>
    <link>${origin}/links.html</link>
    <description>Links shared during the Simply Cyber Daily Threat Briefing</description>
    <language>en-us</language>
    <atom:link href="${origin}/api/links/rss" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;

    return new Response(xml, {
        status: 200,
        headers: {
            "Content-Type": "application/rss+xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
        },
    });
}
