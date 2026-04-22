var TOKEN = null;
var currentRange = "30d";
var charts = {};

var $ = function (s) { return document.querySelector(s); };

function escapeHtml(s) {
    var d = document.createElement("div");
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
}

function card(k, v, cls) {
    var n = document.createElement("div");
    n.className = "card";
    var kDiv = document.createElement("div");
    kDiv.className = "k";
    kDiv.textContent = k;
    var vDiv = document.createElement("div");
    vDiv.className = "v " + (cls || "");
    vDiv.textContent = String(v);
    n.appendChild(kDiv);
    n.appendChild(vDiv);
    return n;
}

function fmtDuration(secs) {
    if (secs == null) return "—";
    if (secs < 90) return secs + "s";
    if (secs < 5400) return Math.round(secs / 60) + "m";
    if (secs < 172800) return Math.round(secs / 3600) + "h";
    return Math.round(secs / 86400) + "d";
}

async function fetchJson(path) {
    var opts = { credentials: "include" };
    if (TOKEN && TOKEN !== "__cookie__") {
        opts.headers = { Authorization: "Bearer " + TOKEN };
    }
    var r = await fetch(path, opts);
    if (r.status === 401) throw new Error("unauthorized");
    if (!r.ok) throw new Error(path + " HTTP " + r.status);
    return r.json();
}

function makeChart(canvasId, type, labels, datasets) {
    if (charts[canvasId]) charts[canvasId].destroy();
    var ctx = document.getElementById(canvasId);
    charts[canvasId] = new Chart(ctx, {
        type: type,
        data: { labels: labels, datasets: datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: datasets.length > 1, labels: { color: "#95a4b3", font: { size: 11 } } } },
            scales: {
                x: { ticks: { color: "#6b7a8a", font: { size: 10 } }, grid: { color: "#1e2833" } },
                y: { beginAtZero: true, ticks: { color: "#6b7a8a", font: { size: 10 } }, grid: { color: "#1e2833" } },
            },
        },
    });
}

function renderGrowth(data) {
    var el = $("#growth-cards");
    el.textContent = "";
    var h = data.headlines;
    el.appendChild(card("Total Users", h.total_users));
    el.appendChild(card("Verified", h.verified_users));
    el.appendChild(card("Active (30d)", h.active_attenders_30d));
    el.appendChild(card("New (period)", "+" + h.new_registrations));

    var labels = data.series.map(function (r) { return r.period; });
    var counts = data.series.map(function (r) { return r.count; });
    makeChart("growth-chart", "line", labels, [{
        label: "Registrations",
        data: counts,
        borderColor: "#7cc3ff",
        backgroundColor: "rgba(124,195,255,0.1)",
        fill: true,
        tension: 0.3,
    }]);
}

function renderEngagement(data) {
    var el = $("#engagement-cards");
    el.textContent = "";
    var h = data.headlines;
    el.appendChild(card("Avg / Stream", h.avg_attendance_per_stream));
    el.appendChild(card("CPE Awarded", h.total_cpe_awarded));
    el.appendChild(card("Empty Streams", h.streams_with_zero_attendance));

    var labels = data.series.map(function (r) { return r.period; });
    var counts = data.series.map(function (r) { return r.count; });
    makeChart("engagement-chart", "line", labels, [{
        label: "Attendance",
        data: counts,
        borderColor: "#55d38b",
        backgroundColor: "rgba(85,211,139,0.1)",
        fill: true,
        tension: 0.3,
    }]);
}

function renderCerts(data) {
    var el = $("#certs-cards");
    el.textContent = "";
    var h = data.headlines;
    el.appendChild(card("Issued (period)", h.issued_this_period));
    el.appendChild(card("Pending Now", h.pending_now));
    el.appendChild(card("Avg Delivery", fmtDuration(h.avg_delivery_seconds)));
    el.appendChild(card("View Rate", h.view_rate_pct != null ? h.view_rate_pct + "%" : "—"));

    var labels = data.series.map(function (r) { return r.period; });
    var counts = data.series.map(function (r) { return r.count; });
    makeChart("certs-chart", "bar", labels, [{
        label: "Certs Issued",
        data: counts,
        backgroundColor: "#d4a73a",
        borderRadius: 3,
    }]);
}

function renderSystem(data) {
    var el = $("#system-cards");
    el.textContent = "";
    var h = data.headlines;
    el.appendChild(card("Email Success", h.email_success_rate_pct != null ? h.email_success_rate_pct + "%" : "—"));
    el.appendChild(card("Emails Sent", h.emails_sent));
    el.appendChild(card("Open Appeals", h.appeals_open));
    el.appendChild(card("Avg Appeal Time", fmtDuration(h.avg_appeal_resolution_seconds)));

    var labels = data.series.map(function (r) { return r.period; });
    var sent = data.series.map(function (r) { return r.sent; });
    var failed = data.series.map(function (r) { return r.failed; });
    makeChart("system-chart", "bar", labels, [
        { label: "Sent", data: sent, backgroundColor: "#55d38b", borderRadius: 3 },
        { label: "Failed", data: failed, backgroundColor: "#e85a5a", borderRadius: 3 },
    ]);
}

async function loadAll() {
    $("#err").textContent = "";
    var qs = "?range=" + currentRange;
    try {
        var results = await Promise.all([
            fetchJson("/api/admin/analytics/growth" + qs),
            fetchJson("/api/admin/analytics/engagement" + qs),
            fetchJson("/api/admin/analytics/certs" + qs),
            fetchJson("/api/admin/analytics/system" + qs),
        ]);
        renderGrowth(results[0]);
        renderEngagement(results[1]);
        renderCerts(results[2]);
        renderSystem(results[3]);
        $("#ts").textContent = "updated " + new Date().toLocaleTimeString();
    } catch (e) {
        var errDiv = document.createElement("div");
        errDiv.className = "err";
        errDiv.textContent = e.message;
        $("#err").textContent = "";
        $("#err").appendChild(errDiv);
        if (String(e.message).includes("unauthorized")) {
            $("#app").style.display = "none";
            $("#login").style.display = "";
        }
    }
}

document.querySelectorAll(".range-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
        document.querySelectorAll(".range-btn").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        currentRange = btn.dataset.range;
        loadAll();
    });
});

var signoutBtn = $("#signout");
if (signoutBtn) {
    signoutBtn.addEventListener("click", async function () {
        await fetch("/api/admin/auth/logout", { method: "POST", credentials: "include" });
        TOKEN = null;
        $("#app").style.display = "none";
        $("#login").style.display = "";
        location.reload();
    }, { once: true });
}

(async function init() {
    try {
        var testR = await fetch("/api/admin/analytics/growth?range=7d", { credentials: "include" });
        if (testR.ok) {
            TOKEN = "__cookie__";
            $("#login").style.display = "none";
            $("#app").style.display = "";
            loadAll("30d");
            return;
        }
    } catch (e) {}

    var params = new URLSearchParams(location.search);
    if (params.get("error") === "expired") {
        var le = $("#login-err");
        le.textContent = "Login link expired or already used. Request a new one.";
        le.hidden = false;
        history.replaceState(null, "", location.pathname);
    }

    var form = $("#login-form");
    if (form) {
        form.addEventListener("submit", async function (e) {
            e.preventDefault();
            var emailInput = $("#admin-email");
            var errEl = $("#login-err");
            var okEl = $("#login-ok");
            errEl.hidden = true;
            var fd = new FormData(form);
            var turnstileToken = fd.get("cf-turnstile-response");
            if (!turnstileToken) {
                errEl.textContent = "Please complete the anti-bot challenge.";
                errEl.hidden = false;
                return;
            }
            var btn = form.querySelector("button[type=submit]");
            btn.disabled = true;
            btn.textContent = "Sending…";
            try {
                var r = await fetch("/api/admin/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        email: emailInput.value.trim(),
                        turnstile_token: turnstileToken,
                        redirect: "/analytics.html",
                    }),
                });
                var data = await r.json();
                if (!r.ok) {
                    errEl.textContent = data.error || "Login failed.";
                    errEl.hidden = false;
                    return;
                }
                form.hidden = true;
                okEl.hidden = false;
            } catch (x) {
                errEl.textContent = "Network error — check your connection.";
                errEl.hidden = false;
            } finally {
                btn.disabled = false;
                btn.textContent = "Send login link";
            }
        });
    }
})();
