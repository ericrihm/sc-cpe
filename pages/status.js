var FRIENDLY = {
  poller: {
    label: "YouTube chat poller",
    help: "Credits attendance while the Daily Threat Briefing is live. Only on duty ET Mon\u2013Fri 08:00\u201311:00.",
  },
  purge: {
    label: "Daily chat purge",
    help: "Cleans raw chat logs from R2. Runs once a day.",
  },
  email_sender: {
    label: "Email delivery",
    help: "Drains registration, recovery, and monthly certificate emails. Runs every 2 minutes.",
  },
  security_alerts: {
    label: "Security alerts digest",
    help: "Scans the audit log daily for anything suspicious. Piggybacks on the purge cron.",
  },
  canary: {
    label: "Hourly canary",
    help: "External synthetic smoke from GitHub Actions. Beats every hour.",
  },
};
function fmtAge(s) {
  if (s == null) return "\u2014";
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s/60) + "m " + (s%60) + "s";
  return Math.floor(s/3600) + "h " + Math.floor((s%3600)/60) + "m";
}
async function refresh() {
  var hero = document.getElementById("hero");
  try {
    var r = await fetch("/api/health", { cache: "no-store" });
    var d = await r.json();
    hero.className = "status-hero " + (d.any_stale ? "stale" : "ok");
    hero.textContent = d.any_stale
      ? "Some components are stale \u2014 see below"
      : "All systems operational";
    var box = document.getElementById("sources"); box.innerHTML = "";
    for (var i = 0; i < d.sources.length; i++) {
      var s = d.sources[i];
      var row = document.createElement("div");
      row.className = "src-row" + (s.stale ? " stale" : "");
      var fri = FRIENDLY[s.source] || { label: s.source, help: "" };
      var badgeCls = !s.expected ? "offduty" : s.stale ? "stale" : "ok";
      var badgeText = !s.expected ? "off duty" : s.stale ? "stale" : "ok";
      row.innerHTML =
        '<div class="src-name">' + fri.label + '</div>' +
        '<span class="src-badge ' + badgeCls + '">' + badgeText + '</span>' +
        '<div class="src-help">' + fri.help + '</div>' +
        '<div class="src-meta">last ' + (s.last_beat_at ? fmtAge(s.age_seconds) + " ago" : "never") + '</div>';
      box.appendChild(row);
    }
    document.getElementById("foot").textContent =
      "Last checked " + new Date(d.now).toLocaleString() +
      " \u00b7 poll window active: " + (d.poll_window_active ? "yes" : "no");
  } catch (e) {
    hero.className = "status-hero stale";
    hero.textContent = "Could not fetch status \u2014 the status endpoint itself may be down.";
    document.getElementById("foot").textContent = "Error: " + (e && e.message || e);
  }
}
refresh();
setInterval(refresh, 30000);
