import { clientIp, ipHash, rateLimit } from "../../_lib.js";

export async function onRequestGet({ params, env, request }) {
    const token = params.token;
    if (!token || token.length < 32) {
        return new Response("invalid token", { status: 400 });
    }

    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, `badge:${ipH}`, 300);
    if (!rl.ok) {
        return new Response("rate limited", { status: rl.status });
    }

    const user = await env.DB.prepare(`
        SELECT id, legal_name, state
        FROM users WHERE badge_token = ?1 AND deleted_at IS NULL
    `).bind(token).first();

    if (!user) {
        return new Response("not found", { status: 404 });
    }

    const attendance = await env.DB.prepare(`
        SELECT a.earned_cpe, s.scheduled_date
        FROM attendance a JOIN streams s ON s.id = a.stream_id
        WHERE a.user_id = ?1
        ORDER BY s.scheduled_date DESC
    `).bind(user.id).all();

    const rows = attendance.results || [];
    const totalCpe = rows.reduce((s, r) => s + r.earned_cpe, 0);
    const streak = computeStreak(rows);

    const firstName = (user.legal_name || "User").split(/\s+/)[0];

    const svg = renderBadgeSvg({
        name: firstName,
        totalCpe: totalCpe.toFixed(1),
        streak,
        sessions: rows.length,
    });

    return new Response(svg, {
        headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "public, max-age=3600",
            "Cross-Origin-Resource-Policy": "cross-origin",
        },
    });
}

function computeStreak(rows) {
    if (rows.length === 0) return 0;
    const dates = [...new Set(rows.map(r => r.scheduled_date).filter(Boolean))].sort().reverse();
    if (dates.length === 0) return 0;

    let streak = 1;
    for (let i = 1; i < dates.length; i++) {
        const prev = new Date(dates[i - 1]);
        const curr = new Date(dates[i]);
        const diffDays = Math.round((prev - curr) / 86400000);
        // Weekday gaps: allow up to 3 days (Fri->Mon) to keep streak alive
        if (diffDays <= 3) {
            streak++;
        } else {
            break;
        }
    }
    return streak;
}

function escSvg(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

function renderBadgeSvg({ name, totalCpe, streak, sessions }) {
    const w = 480, h = 260;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b3d5c"/>
      <stop offset="100%" stop-color="#0a2e44"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#d4a73a"/>
      <stop offset="100%" stop-color="#e8c455"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" rx="16" fill="url(#bg)"/>
  <rect x="0" y="0" width="${w}" height="68" rx="16" fill="#072a3e"/>
  <rect x="0" y="40" width="${w}" height="28" fill="#072a3e"/>
  <text x="24" y="32" font-family="system-ui,Segoe UI,sans-serif" font-size="11" fill="#7cc3ff" letter-spacing="3" text-transform="uppercase">SIMPLY CYBER</text>
  <text x="24" y="55" font-family="system-ui,Segoe UI,sans-serif" font-size="18" font-weight="700" fill="#ffffff">SC-CPE Verified</text>
  <circle cx="${w - 44}" cy="34" r="22" fill="none" stroke="url(#gold)" stroke-width="2"/>
  <text x="${w - 44}" y="40" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#d4a73a">CPE</text>
  <text x="24" y="105" font-family="system-ui,Segoe UI,sans-serif" font-size="15" fill="#95a4b3">${escSvg(name)}</text>
  <text x="24" y="148" font-family="system-ui,Segoe UI,sans-serif" font-size="42" font-weight="700" fill="#ffffff">${escSvg(totalCpe)}</text>
  <text x="24" y="170" font-family="system-ui,Segoe UI,sans-serif" font-size="13" fill="#7cc3ff">CPE earned</text>
  <line x1="220" y1="120" x2="220" y2="180" stroke="#1a4a6e" stroke-width="1"/>
  <text x="244" y="148" font-family="system-ui,Segoe UI,sans-serif" font-size="42" font-weight="700" fill="#ffffff">${streak}</text>
  <text x="244" y="170" font-family="system-ui,Segoe UI,sans-serif" font-size="13" fill="#7cc3ff">day streak</text>
  <line x1="360" y1="120" x2="360" y2="180" stroke="#1a4a6e" stroke-width="1"/>
  <text x="384" y="148" font-family="system-ui,Segoe UI,sans-serif" font-size="42" font-weight="700" fill="#ffffff">${sessions}</text>
  <text x="384" y="170" font-family="system-ui,Segoe UI,sans-serif" font-size="13" fill="#7cc3ff">sessions</text>
  <rect x="24" y="200" width="${w - 48}" height="1" fill="#1a4a6e"/>
  <text x="24" y="232" font-family="system-ui,Segoe UI,sans-serif" font-size="11" fill="#5b7a93">Verified via cryptographic audit chain</text>
  <text x="${w - 24}" y="232" text-anchor="end" font-family="system-ui,Segoe UI,sans-serif" font-size="11" fill="#d4a73a">simplycyber.io</text>
</svg>`;
}
