let availableDates = [];
let currentIndex = 0;

async function load(date) {
    const errEl = document.getElementById("err");
    const listEl = document.getElementById("links-list");
    const emptyEl = document.getElementById("empty");
    const noDataEl = document.getElementById("no-data");
    const navEl = document.getElementById("date-nav");
    const streamEl = document.getElementById("stream-info");

    errEl.hidden = true;
    emptyEl.hidden = true;
    noDataEl.hidden = true;
    listEl.textContent = "";
    streamEl.hidden = true;
    streamEl.textContent = "";

    try {
        const params = date ? `?date=${encodeURIComponent(date)}` : "";
        const r = await fetch(`/api/links${params}`);
        if (!r.ok) {
            errEl.textContent = `Error loading links (${r.status}).`;
            errEl.hidden = false;
            return;
        }
        const d = await r.json();

        if (!d.date || d.available_dates.length === 0) {
            noDataEl.hidden = false;
            return;
        }

        availableDates = d.available_dates;
        currentIndex = availableDates.indexOf(d.date);
        if (currentIndex === -1) currentIndex = 0;

        updateNav();
        navEl.hidden = false;

        if (d.stream) {
            if (d.stream.title) {
                streamEl.appendChild(document.createTextNode(d.stream.title));
            }
            if (d.stream.yt_video_id) {
                if (d.stream.title) streamEl.appendChild(document.createTextNode(" · "));
                const ytLink = document.createElement("a");
                ytLink.href = "https://www.youtube.com/watch?v=" + encodeURIComponent(d.stream.yt_video_id);
                ytLink.target = "_blank";
                ytLink.rel = "noopener";
                ytLink.textContent = "Watch on YouTube";
                streamEl.appendChild(ytLink);
            }
            streamEl.hidden = false;
        }

        const links = d.links || [];
        if (links.length === 0) {
            emptyEl.hidden = false;
            return;
        }

        for (const link of links) {
            listEl.appendChild(renderCard(link));
        }
    } catch {
        errEl.textContent = "Failed to load links.";
        errEl.hidden = false;
    }
}

function renderCard(link) {
    const card = document.createElement("div");
    card.className = "link-card";

    const title = link.title || link.url;
    const authorLabel = link.author_type === "owner" ? "Host" : "Mod";
    const time = formatTime(link.posted_at);

    var header = document.createElement("div");
    header.className = "link-header";

    var domain = document.createElement("span");
    domain.className = "link-domain";
    domain.textContent = link.domain;
    header.appendChild(domain);

    var timeEl = document.createElement("span");
    timeEl.className = "link-time";
    timeEl.textContent = time;
    header.appendChild(timeEl);

    var author = document.createElement("span");
    author.className = "link-author";
    var badge = document.createElement("span");
    badge.className = "link-author-badge " + link.author_type;
    badge.textContent = authorLabel;
    author.appendChild(badge);
    author.appendChild(document.createTextNode(link.author_name));
    header.appendChild(author);

    card.appendChild(header);

    var titleDiv = document.createElement("div");
    titleDiv.className = "link-title";
    var titleLink = document.createElement("a");
    titleLink.href = link.url;
    titleLink.target = "_blank";
    titleLink.rel = "noopener";
    titleLink.textContent = title;
    titleDiv.appendChild(titleLink);
    card.appendChild(titleDiv);

    if (link.description) {
        var desc = document.createElement("div");
        desc.className = "link-desc";
        desc.textContent = link.description;
        card.appendChild(desc);
    }

    if (link.title) {
        var urlDiv = document.createElement("div");
        urlDiv.className = "link-url";
        urlDiv.textContent = link.url;
        card.appendChild(urlDiv);
    }

    return card;
}

function updateNav() {
    var label = document.getElementById("date-label");
    var prev = document.getElementById("prev-date");
    var next = document.getElementById("next-date");

    var d = availableDates[currentIndex];
    label.textContent = formatDate(d);
    prev.disabled = currentIndex >= availableDates.length - 1;
    next.disabled = currentIndex <= 0;

    var newUrl = new URL(window.location);
    newUrl.searchParams.set("date", d);
    history.replaceState(null, "", newUrl);
}

function formatDate(iso) {
    var parts = iso.split("-").map(Number);
    var y = parts[0], m = parts[1], day = parts[2];
    var months = ["January","February","March","April","May","June",
        "July","August","September","October","November","December"];
    var days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    var dt = new Date(y, m - 1, day);
    return days[dt.getDay()] + ", " + months[m - 1] + " " + day + ", " + y;
}

function formatTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

document.getElementById("prev-date").addEventListener("click", function() {
    if (currentIndex < availableDates.length - 1) {
        currentIndex++;
        load(availableDates[currentIndex]);
    }
});

document.getElementById("next-date").addEventListener("click", function() {
    if (currentIndex > 0) {
        currentIndex--;
        load(availableDates[currentIndex]);
    }
});

var params = new URLSearchParams(window.location.search);
load(params.get("date") || null);
