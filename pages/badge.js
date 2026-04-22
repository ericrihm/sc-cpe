const token = new URLSearchParams(location.search).get("t");
const errEl = document.getElementById("err");

async function load() {
    if (!token) { errEl.textContent = "Missing badge token in URL."; errEl.hidden = false; return; }

    const badgeUrl = `/api/badge/${encodeURIComponent(token)}`;
    const r = await fetch(badgeUrl);
    if (!r.ok) {
        errEl.textContent = r.status === 404
            ? "Badge not found."
            : `Error loading badge (${r.status}).`;
        errEl.hidden = false;
        return;
    }

    const svgText = await r.text();
    const blob = new Blob([svgText], { type: "image/svg+xml" });
    const blobUrl = URL.createObjectURL(blob);
    document.getElementById("badge-img").src = blobUrl;

    const ogImg = document.querySelector('meta[property="og:image"]');
    if (!ogImg) {
        const meta = document.createElement("meta");
        meta.setAttribute("property", "og:image");
        meta.setAttribute("content", location.origin + badgeUrl);
        document.head.appendChild(meta);
    }
    const twImg = document.querySelector('meta[name="twitter:image"]');
    if (!twImg) {
        const meta = document.createElement("meta");
        meta.setAttribute("name", "twitter:image");
        meta.setAttribute("content", location.origin + badgeUrl);
        document.head.appendChild(meta);
    }

    const cpeMatch = svgText.match(/>(\d+\.\d+)<\/text>\s*<text[^>]*>CPE earned/);
    const streakMatch = svgText.match(/>(\d+)<\/text>\s*<text[^>]*>day streak/);
    const sessionsMatch = svgText.match(/>(\d+)<\/text>\s*<text[^>]*>sessions/);

    const cpe = cpeMatch ? cpeMatch[1] : "0.0";
    const streak = streakMatch ? streakMatch[1] : "0";
    const sessions = sessionsMatch ? sessionsMatch[1] : "0";

    document.getElementById("stat-cpe").textContent = cpe;
    document.getElementById("stat-streak").textContent = streak;
    document.getElementById("stat-sessions").textContent = sessions;

    const pageUrl = location.href;
    const shareText = `I've earned ${cpe} CPE credits attending Simply Cyber's Daily Threat Briefing! Verified via cryptographic audit chain. #SimplyCyber #CPE`;

    document.getElementById("share-linkedin").href =
        `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}`;
    document.getElementById("share-x").href =
        `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(pageUrl)}`;

    document.getElementById("body").hidden = false;
}
load().catch(function () {
    var e = document.getElementById("err");
    e.textContent = "Failed to load badge. Check your connection and try again.";
    e.hidden = false;
});
