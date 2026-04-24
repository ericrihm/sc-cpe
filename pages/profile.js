var token = new URLSearchParams(location.search).get("t");

async function load() {
    var errEl = document.getElementById("err");
    if (!token) {
        document.getElementById("not-found").hidden = false;
        return;
    }
    try {
        var r = await fetch("/api/profile/" + encodeURIComponent(token));
        if (r.status === 404) {
            document.getElementById("not-found").hidden = false;
            return;
        }
        if (!r.ok) {
            errEl.textContent = "Error loading profile (" + r.status + ").";
            errEl.hidden = false;
            return;
        }
        var d = await r.json();
        document.getElementById("profile").hidden = false;
        document.getElementById("profile-name").textContent = d.display_name;
        document.getElementById("profile-since").textContent =
            "Member since " + formatDate(d.member_since);
        document.getElementById("stat-cpe").textContent = Number(d.total_cpe).toFixed(1);
        document.getElementById("stat-sessions").textContent = d.total_sessions;
        document.getElementById("stat-certs").textContent = d.certs_earned;
        document.getElementById("stat-streak").textContent = d.current_streak;
        if (d.current_streak > 0) {
            document.getElementById("streak-fire").hidden = false;
        }
        document.getElementById("stat-best-streak").textContent = d.longest_streak;

        document.title = d.display_name + " — SC-CPE Profile";
    } catch (e) {
        errEl.textContent = "Failed to load profile.";
        errEl.hidden = false;
    }
}

function formatDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
        year: "numeric", month: "short", day: "numeric",
    });
}

load();
