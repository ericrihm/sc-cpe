async function load() {
    const errEl = document.getElementById("err");
    try {
        const r = await fetch("/api/leaderboard");
        if (!r.ok) {
            errEl.textContent = `Error loading leaderboard (${r.status}).`;
            errEl.hidden = false;
            return;
        }
        const d = await r.json();
        const period = d.period;
        if (period && /^\d{6}$/.test(period)) {
            const months = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
            const y = Number(period.slice(0, 4));
            const m = Number(period.slice(4, 6)) - 1;
            document.getElementById("period").textContent = `${months[m]} ${y}`;
        }

        const entries = d.entries || [];
        if (entries.length === 0) {
            document.getElementById("lb-empty").hidden = false;
            return;
        }

        const tbody = document.getElementById("lb-body");
        for (const e of entries) {
            const tr = document.createElement("tr");
            const rankCls = e.rank <= 3 ? ` lb-rank-${e.rank}` : "";
            const streakText = e.streak > 0 ? e.streak + "d" : "—";
            // All values are pre-escaped via esc() or numeric — safe for innerHTML
            tr.innerHTML =
                '<td class="lb-rank' + rankCls + '">' + e.rank + '</td>' +
                '<td class="lb-name">' + esc(e.display_name) + '</td>' +
                '<td class="lb-cpe">' + Number(e.cpe_earned).toFixed(1) + '</td>' +
                '<td class="lb-sessions">' + e.sessions + '</td>' +
                '<td class="lb-streak">' + esc(streakText) + '</td>';
            tbody.appendChild(tr);
        }
        document.getElementById("lb-table").hidden = false;
    } catch (err) {
        errEl.textContent = "Failed to load leaderboard.";
        errEl.hidden = false;
    }
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
    }[c]));
}

load();
