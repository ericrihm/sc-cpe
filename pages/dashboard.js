var STORAGE_KEY = "sc_cpe_session";
var SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function getSavedSession() {
    try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        var s = JSON.parse(raw);
        if (!s.token || !s.saved_at) return null;
        if (Date.now() - s.saved_at > SESSION_MAX_AGE_MS) {
            localStorage.removeItem(STORAGE_KEY);
            return null;
        }
        return s;
    } catch (e) { return null; }
}

function saveSession(t, name) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            token: t, name: name, saved_at: Date.now(),
        }));
    } catch (e) {}
}

function clearSession() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
}

var token = new URLSearchParams(location.search).get("t");
if (!token) {
    var saved = getSavedSession();
    if (saved) token = saved.token;
}
var err = document.getElementById("err");
var loadInProgress = false;

function showLogin() {
    document.getElementById("skel").hidden = true;
    document.getElementById("login-card").hidden = false;
}

async function load() {
    if (loadInProgress) return;
    if (!token) { showLogin(); return; }
    loadInProgress = true;
    try {
    var r = await fetch("/api/me/" + encodeURIComponent(token));
    if (!r.ok) {
        if (r.status === 404) clearSession();
        if (r.status === 404) { showLogin(); return; }
        err.textContent = "Error loading dashboard (" + r.status + ").";
        err.hidden = false;
        document.getElementById("skel").hidden = true;
        return;
    }
    var d = await r.json();
    document.getElementById("skel").hidden = true;
    document.getElementById("body").hidden = false;
    document.getElementById("name").textContent = d.user.legal_name;
    document.getElementById("state").textContent = d.user.state;
    userState = d.user.state;

    var hasSaved = !!getSavedSession();
    var rememberCard = document.getElementById("remember-card");
    var signoutCard = document.getElementById("signout-card");
    if (hasSaved) {
        saveSession(token, d.user.legal_name);
        if (signoutCard) signoutCard.hidden = false;
    } else if (rememberCard) {
        rememberCard.hidden = false;
    }

    if (token && !new URLSearchParams(location.search).get("t")) {
        history.replaceState(null, "", "/dashboard");
    }

    document.getElementById("rotate-card").hidden = false;

    if (d.user.state === "active") {
        var prefsCard = document.getElementById("prefs-card");
        prefsCard.hidden = false;
        var style = (d.user.email_prefs && d.user.email_prefs.cert_style) || "bundled";
        var radio = document.querySelector('input[name="cert_style"][value="' + style + '"]');
        if (radio) radio.checked = true;

        document.getElementById("leaderboard-card").hidden = false;
        document.getElementById("leaderboard-toggle").checked = !!d.user.show_on_leaderboard;
    }

    if (d.user.state === "pending_verification") {
        document.getElementById("pending").hidden = false;
        renderCodeStatus(d.user.code_state, d.user.code_expires_at);
    } else if (d.user.state === "active") {
        document.getElementById("active").hidden = false;
        var channelId = d.user.yt_channel_id || "";
        var displayName = d.user.yt_display_name_seen || "";
        var line = document.getElementById("link-line");
        var hint = document.getElementById("link-hint");
        var channelWrap = document.getElementById("channel-wrap");

        if (channelId && displayName) {
            line.innerHTML = "Linked to YouTube as <strong>" + escapeHtml(displayName) + "</strong>";
            document.getElementById("channel").textContent = channelId;
            channelWrap.hidden = false;
            hint.hidden = true;
        } else if (channelId) {
            line.innerHTML = 'Linked to YouTube <span class="pill pill-green" style="margin-left:4px;">Verified</span>';
            document.getElementById("channel").textContent = channelId;
            channelWrap.hidden = false;
            hint.hidden = true;
        } else {
            line.innerHTML = 'Account <span class="pill pill-green" style="margin-left:4px;">Active</span> <span class="pill pill-amber" style="margin-left:4px;">YouTube not linked</span>';
            channelWrap.hidden = true;
            hint.hidden = true;
            document.getElementById("link-card").hidden = false;
            renderLinkCodeStatus(d.user.code_state, d.user.code_expires_at);
        }

        if (d.user.verified_at) {
            document.getElementById("verified-at-line").textContent =
                "Verified " + formatDateTime(d.user.verified_at);
            document.getElementById("verified-at-line").hidden = false;
        }
    }

    var cpe = Number(d.total_cpe_earned != null ? d.total_cpe_earned : 0);
    document.getElementById("total").textContent = cpe.toFixed(1) + " CPE";
    document.getElementById("share-btn").hidden = cpe <= 0;

    renderWindowWarnings(d.code_window_warnings || []);

    calData = { attendance: d.attendance || [], appeals: d.appeals || [] };
    renderToday(d.today);
    renderCalendar();

    renderAttendance(d.attendance || []);

    renderCerts(d.certs || []);
    renderStreaks(d.attendance || []);
    if (d.user.state === "active") {
        renderRenewalTracker(d.user.email_prefs, Number(d.total_cpe_earned != null ? d.total_cpe_earned : 0));
    }
    } finally { loadInProgress = false; }
}

function formatDateTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
    });
}

function formatDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
        year: "numeric", month: "short", day: "numeric",
    });
}

function attendanceBadge(row) {
    var hasEvidence = row.first_msg_sha256 && row.first_msg_sha256.length > 0;
    if (row.source === "poll") {
        return { cls: "pill-green", label: "Credited (live chat)",
                 title: "Your message was seen in YouTube live chat during the live window." };
    }
    if (row.source === "admin_manual" && hasEvidence) {
        return { cls: "pill-green", label: "Credited (admin-reconciled)",
                 title: "Credit was added by an admin with chat evidence validated against the live window." };
    }
    if (row.source === "admin_manual") {
        return { cls: "pill-amber", label: "Granted (admin)",
                 title: "Credit was added manually by an admin without chat-evidence validation." };
    }
    if (row.source === "appeal_granted") {
        return { cls: "pill-amber", label: "Credit via appeal",
                 title: "Credit was granted after you filed an appeal." };
    }
    return { cls: "pill-grey", label: row.source };
}

function renderWindowWarnings(warnings) {
    var card = document.getElementById("window-warn-card");
    var body = document.getElementById("window-warn-body");
    if (!warnings.length) { card.hidden = true; return; }
    card.hidden = false;
    body.innerHTML = "";
    var intro = document.createElement("p");
    intro.style.margin = "0 0 6px";
    intro.textContent = warnings.length === 1
        ? "We detected a chat message that couldn\u2019t be credited:"
        : "We detected " + warnings.length + " chat messages that couldn\u2019t be credited:";
    body.appendChild(intro);
    var ul = document.createElement("ul");
    ul.className = "warn-list";
    for (var i = 0; i < warnings.length && i < 5; i++) {
        var w = warnings[i];
        var li = document.createElement("li");
        var when = formatDateTime(w.posted_at);
        var openAt = formatDateTime(w.window_open_at);
        var label = w.kind === "attendance"
            ? "Your message at <strong>" + escapeHtml(when) + "</strong> was posted before the live window opened (" + escapeHtml(openAt) + ") \u2014 no attendance credit was applied."
            : "Your verification code was posted at <strong>" + escapeHtml(when) + "</strong>, before the live window opened (" + escapeHtml(openAt) + ") \u2014 account not verified from that post.";
        li.innerHTML = label;
        ul.appendChild(li);
    }
    body.appendChild(ul);
}

function renderAttendance(items) {
    var host = document.getElementById("att");
    host.innerHTML = "";
    if (items.length === 0) {
        document.getElementById("att-empty").hidden = false;
        return;
    }
    host.hidden = false;
    for (var i = 0; i < items.length; i++) {
        var a = items[i];
        var row = document.createElement("div");
        row.className = "att-row";
        var title = escapeHtml(a.title || a.yt_video_id);
        var yt = "https://youtu.be/" + encodeURIComponent(a.yt_video_id);
        var badge = attendanceBadge(a);
        var headerRight = '<span class="pill ' + badge.cls + '"' + (badge.title ? ' title="' + escapeHtml(badge.title) + '"' : "") + ">" + escapeHtml(badge.label) + "</span>";
        var date = formatDate(a.scheduled_date);
        var hasEvidence = a.first_msg_sha256 && a.first_msg_sha256.length > 0;
        var metaParts = [date, a.earned_cpe + " CPE"];
        if (a.source === "poll" || hasEvidence) {
            metaParts.push("first message " + formatDateTime(a.first_msg_at));
        }
        if (a.credited_at) metaParts.push("credited " + formatDateTime(a.credited_at));
        var meta = metaParts.join(" \u00b7 ");
        var actions = a.per_session_cert_exists
            ? '<span class="att-ps-done">per-session cert issued</span>'
            : '<button type="button" class="att-ps-btn" data-stream="' + a.stream_id + '">Request per-session cert</button>';
        row.innerHTML =
            '<div class="att-row-top"><div>' +
            '<div class="att-title"><a href="' + yt + '" target="_blank" rel="noopener">' + title + "</a></div>" +
            '<div class="att-meta">' + meta + "</div>" +
            "</div>" + headerRight + "</div>" +
            '<div class="att-actions">' + actions + "</div>";
        host.appendChild(row);
    }
}

document.getElementById("att").addEventListener("click", async function (e) {
    var btn = e.target.closest(".att-ps-btn");
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    var stream = btn.dataset.stream;
    var original = btn.textContent;
    btn.textContent = "sending\u2026";
    try {
        var r = await fetch(
            "/api/me/" + encodeURIComponent(token) + "/cert-per-session/" + encodeURIComponent(stream),
            { method: "POST", headers: { "Content-Type": "application/json" } },
        );
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        btn.outerHTML = '<span class="att-ps-done">' + (j.existing ? "already issued" : "queued \u2014 arrives within ~2h") + "</span>";
    } catch (err) {
        btn.disabled = false;
        btn.textContent = original;
        btn.title = String(err.message || err);
    }
});

function formatPeriod(yyyymm) {
    if (!/^\d{6}$/.test(yyyymm)) return yyyymm;
    var year = Number(yyyymm.slice(0, 4));
    var mo = Number(yyyymm.slice(4, 6)) - 1;
    var months = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
    if (mo < 0 || mo > 11) return yyyymm;
    return months[mo] + " " + year;
}

function certStatePill(c, isSuperseded) {
    if (isSuperseded) return { cls: "pill-grey", label: "Replaced", title: "Superseded by a newer cert for this period." };
    switch (c.state) {
        case "delivered": return { cls: "pill-green", label: "Delivered" };
        case "viewed_by_auditor": return { cls: "pill-green", label: "Viewed by auditor" };
        case "generated": return { cls: "pill-amber", label: "Signed \u2014 not yet delivered" };
        case "pending": return { cls: "pill-amber", label: "Signing\u2026" };
        case "revoked": return { cls: "pill-red", label: "Revoked" };
        default: return { cls: "pill-grey", label: c.state };
    }
}

function certKindLabel(k) {
    return k === "per_session" ? "per-session" : "monthly bundle";
}

function renderCerts(items) {
    var host = document.getElementById("certs");
    host.innerHTML = "";
    if (items.length === 0) {
        document.getElementById("cert-empty").hidden = false;
        return;
    }
    host.hidden = false;
    allCertsData = items;
    var downloadable = items.filter(function (c) { return c.public_token && (c.state === "delivered" || c.state === "viewed_by_auditor" || c.state === "generated"); });
    if (downloadable.length >= 2) {
        document.getElementById("cert-dl-bar").hidden = false;
    }

    var groups = new Map();
    for (var i = 0; i < items.length; i++) {
        var c = items[i];
        var k = c.period_yyyymm + ":" + c.cert_kind;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c);
    }
    var primaryStates = new Set(["delivered", "viewed_by_auditor", "generated", "pending"]);
    for (var list of groups.values()) {
        var primary = list.find(function (c) { return primaryStates.has(c.state); }) || list[0];
        var history = list.filter(function (c) { return c !== primary; });
        host.appendChild(certCard(primary, false));
        if (history.length) {
            var wrap = document.createElement("div");
            var btn = document.createElement("button");
            btn.type = "button"; btn.className = "cert-history-toggle";
            btn.textContent = "Show " + history.length + " earlier version" + (history.length > 1 ? "s" : "");
            var box = document.createElement("div");
            box.hidden = true;
            (function (btn, box, history) {
                btn.addEventListener("click", function () {
                    box.hidden = !box.hidden;
                    btn.textContent = box.hidden
                        ? "Show " + history.length + " earlier version" + (history.length > 1 ? "s" : "")
                        : "Hide earlier versions";
                });
            })(btn, box, history);
            for (var j = 0; j < history.length; j++) box.appendChild(certCard(history[j], true));
            wrap.appendChild(btn); wrap.appendChild(box);
            host.appendChild(wrap);
        }
    }
}

function certCard(c, isSuperseded) {
    var row = document.createElement("div");
    row.className = "cert-row" + (isSuperseded ? " is-superseded" : "");
    var pill = certStatePill(c, isSuperseded);
    var period = formatPeriod(c.period_yyyymm);
    var cpe = Number(c.cpe_total).toFixed(1);
    var s = c.sessions_count === 1 ? "session" : "sessions";
    var timeline = [];
    if (c.generated_at) timeline.push("signed " + formatDateTime(c.generated_at));
    if (c.delivered_at) timeline.push("delivered " + formatDateTime(c.delivered_at));
    if (c.first_viewed_at) timeline.push("first viewed by auditor " + formatDateTime(c.first_viewed_at));
    var timelineHtml = timeline.length
        ? '<div class="cert-meta" style="margin-top:6px;font-style:italic;">' + escapeHtml(timeline.join(" \u00b7 ")) + "</div>"
        : "";

    row.innerHTML =
        '<div class="cert-row-top"><div>' +
        '<div class="cert-period">' + escapeHtml(period) + "</div>" +
        '<div class="cert-meta">' + cpe + " CPE \u00b7 " + c.sessions_count + " " + s + " \u00b7 " + certKindLabel(c.cert_kind) + "</div>" +
        timelineHtml +
        "</div>" +
        '<span class="pill ' + pill.cls + '"' + (pill.title ? ' title="' + escapeHtml(pill.title) + '"' : "") + ">" + escapeHtml(pill.label) + "</span>" +
        "</div>" +
        '<div class="cert-actions">' +
        '<a class="cert-verify" href="/verify.html?t=' + encodeURIComponent(c.public_token) + '" target="_blank" rel="noopener">Open certificate \u2197</a>' +
        '<details class="fb-details" data-cert="' + c.id + '">' +
        "<summary>Report an issue</summary>" +
        '<div class="fb-picker">' +
        '<button type="button" class="fb-btn" data-r="ok" title="Everything looks right">Looks good</button>' +
        '<button type="button" class="fb-btn" data-r="typo" title="Name or metadata typo">Typo</button>' +
        '<button type="button" class="fb-btn" data-r="wrong" title="Wrong data / missing sessions">Wrong</button>' +
        "</div>" +
        '<span class="fb-msg muted" style="display:none;font-size:11px;"></span>' +
        "</details></div>";
    row.querySelector(".fb-picker").addEventListener("click", async function (e) {
        var btn = e.target.closest(".fb-btn");
        if (!btn) return;
        var rating = btn.dataset.r;
        var note = null;
        if (rating !== "ok") {
            note = prompt("What\u2019s " + rating + "? (optional, max 500 chars)") || null;
        }
        var msg = row.querySelector(".fb-msg");
        msg.style.display = "inline";
        msg.textContent = "sending\u2026";
        try {
            var r = await fetch("/api/me/" + encodeURIComponent(token) + "/cert-feedback", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cert_id: c.id, rating: rating, note: note }),
            });
            if (!r.ok) throw new Error("HTTP " + r.status);
            msg.textContent = rating === "ok" ? "thanks!" : "logged \u2014 we\u2019ll follow up";
        } catch (err) {
            msg.textContent = "failed: " + err.message;
        }
    });
    return row;
}

function renderCodeStatus(codeState, codeExpiresAt) {
    var status = document.getElementById("code-status");
    var btn = document.getElementById("resend-btn");
    var friendly = codeExpiresAt
        ? new Date(codeExpiresAt).toLocaleString(undefined, {
            year: "numeric", month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit",
          })
        : "";
    if (codeState === "active") {
        status.innerHTML = '<span class="pill pill-green">Code active</span> expires <strong>' + friendly + "</strong>";
        btn.hidden = false;
        btn.textContent = "Send me a new code";
    } else if (codeState === "expired") {
        status.innerHTML = '<span class="pill pill-red">Code expired</span> <strong class="code-expired-note">expired ' + friendly + "</strong> \u2014 request a fresh one below.";
        btn.hidden = false;
        btn.textContent = "Send me a new code";
    } else {
        status.innerHTML = '<span class="pill pill-amber">No code on file</span> Request one below to get started.';
        btn.hidden = false;
        btn.textContent = "Send me a code";
    }
}

function renderLinkCodeStatus(codeState, codeExpiresAt) {
    var status = document.getElementById("link-code-status");
    var btn = document.getElementById("link-resend-btn");
    var friendly = codeExpiresAt
        ? new Date(codeExpiresAt).toLocaleString(undefined, {
            year: "numeric", month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit",
          })
        : "";
    if (codeState === "active") {
        status.innerHTML = '<span class="pill pill-green">Code active</span> expires <strong>' + friendly + "</strong> \u2014 check your email for the code.";
        btn.textContent = "Send me a new code";
    } else if (codeState === "expired") {
        status.innerHTML = '<span class="pill pill-red">Code expired</span> \u2014 request a fresh one below.';
        btn.textContent = "Send me a new code";
    } else {
        status.innerHTML = '<span class="pill pill-amber">No code on file</span> \u2014 request one below.';
        btn.textContent = "Send me a code";
    }
}

document.getElementById("link-resend-btn").addEventListener("click", async function () {
    var btn = document.getElementById("link-resend-btn");
    var msg = document.getElementById("link-resend-msg");
    btn.disabled = true;
    msg.hidden = true;
    try {
        var r = await fetch("/api/me/" + encodeURIComponent(token) + "/resend-code",
            { method: "POST" });
        var d = await r.json().catch(function () { return {}; });
        if (r.ok) {
            msg.innerHTML = '&#10003; Code sent \u2014 look for <strong>"Simply Cyber CPE \u2014 your new verification code"</strong> from noreply@signalplane.co';
            msg.style.color = "var(--ok-soft-text)";
            renderLinkCodeStatus("active", d.code_expires_at);
        } else if (r.status === 429) {
            msg.textContent = "Too many requests \u2014 try again in an hour.";
            msg.style.color = "var(--bad-soft-text)";
        } else {
            msg.textContent = "Couldn\u2019t send code (" + r.status + ").";
            msg.style.color = "var(--bad-soft-text)";
        }
        msg.hidden = false;
    } catch (e) {
        msg.textContent = "Network error \u2014 try again.";
        msg.style.color = "var(--bad-soft-text)";
        msg.hidden = false;
    } finally {
        btn.disabled = false;
    }
});

document.getElementById("prefs-radios").addEventListener("change", async function (e) {
    var radio = e.target.closest('input[name="cert_style"]');
    if (!radio) return;
    var msg = document.getElementById("prefs-msg");
    msg.hidden = false;
    msg.textContent = "saving\u2026";
    try {
        var r = await fetch("/api/me/" + encodeURIComponent(token) + "/prefs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cert_style: radio.value }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        msg.textContent = "saved \u2014 next monthly run will respect this.";
    } catch (err) {
        msg.textContent = "failed: " + err.message;
    }
});

document.getElementById("rotate-btn").addEventListener("click", async function () {
    if (!confirm("Rotate your dashboard link now?\n\nWe\u2019ll email the new URL to the address on file. This page will stop working a few seconds later.")) return;
    var btn = document.getElementById("rotate-btn");
    var msg = document.getElementById("rotate-msg");
    btn.disabled = true;
    msg.hidden = true;
    try {
        var r = await fetch("/api/me/" + encodeURIComponent(token) + "/rotate",
            { method: "POST" });
        var d = await r.json().catch(function () { return {}; });
        if (r.ok) {
            clearSession();
            if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
            msg.textContent = "Rotated. Check your email for the new link \u2014 this one stops working shortly.";
            msg.style.color = "var(--ok-soft-text)";
            btn.textContent = "Rotated \u2713";
        } else if (r.status === 429) {
            msg.textContent = "Too many rotations \u2014 try again in an hour.";
            msg.style.color = "var(--bad-soft-text)";
            btn.disabled = false;
        } else if (r.status === 403) {
            msg.textContent = "Blocked (origin check failed). Open the dashboard URL directly in your browser.";
            msg.style.color = "var(--bad-soft-text)";
            btn.disabled = false;
        } else {
            msg.textContent = "Couldn\u2019t rotate (" + r.status + ").";
            msg.style.color = "var(--bad-soft-text)";
            btn.disabled = false;
        }
        msg.hidden = false;
    } catch (e) {
        msg.textContent = "Network error \u2014 try again.";
        msg.style.color = "var(--bad-soft-text)";
        msg.hidden = false;
        btn.disabled = false;
    }
});

document.getElementById("resend-btn").addEventListener("click", async function () {
    var btn = document.getElementById("resend-btn");
    var msg = document.getElementById("resend-msg");
    btn.disabled = true;
    msg.hidden = true;
    try {
        var r = await fetch("/api/me/" + encodeURIComponent(token) + "/resend-code",
            { method: "POST" });
        var d = await r.json().catch(function () { return {}; });
        if (r.ok) {
            msg.innerHTML = '&#10003; Code sent \u2014 look for <strong>"Simply Cyber CPE \u2014 your new verification code"</strong> from noreply@signalplane.co';
            msg.style.color = "var(--ok-soft-text)";
        } else if (r.status === 429) {
            msg.textContent = "Too many requests \u2014 try again in an hour.";
            msg.style.color = "var(--bad-soft-text)";
        } else if (r.status === 409) {
            msg.textContent = "Already verified and YouTube linked \u2014 no code needed. Refresh this page.";
            msg.style.color = "var(--ok-soft-text)";
        } else {
            msg.textContent = "Couldn\u2019t send code (" + r.status + ").";
            msg.style.color = "var(--bad-soft-text)";
        }
        msg.hidden = false;
    } catch (e) {
        msg.textContent = "Network error \u2014 try again.";
        msg.style.color = "var(--bad-soft-text)";
        msg.hidden = false;
    } finally {
        btn.disabled = false;
    }
});

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
}

var refreshTimer = null;
var userState = "active";
function renderToday(today) {
    var card = document.getElementById("today-card");
    if (!today) {
        card.hidden = true;
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        return;
    }
    card.hidden = false;
    document.getElementById("today-title").textContent =
        (today.title || "") + (today.actual_start_at
            ? "  \u00b7  started " + new Date(today.actual_start_at).toLocaleTimeString()
            : "");
    var status = document.getElementById("today-status");
    var hint = document.getElementById("today-hint");
    if (today.credited) {
        status.innerHTML = "<strong class='today-credited'>&#10003; Credited</strong> &nbsp;0.5 CPE recorded for this session.";
        hint.hidden = true;
    } else if (today.state === "live") {
        if (userState === "pending_verification") {
            status.innerHTML = "<strong class='today-waiting'>&#128308; The briefing is live now!</strong> Post your <code>SC-CPE{...}</code> code in the YouTube live chat to verify your account and get credit for this session.";
        } else {
            status.innerHTML = "<strong class='today-waiting'>&#9203; Waiting for qualifying message</strong>";
        }
        hint.hidden = userState !== "pending_verification";
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(function () { refreshTimer = null; load(); }, 30000);
        return;
    } else {
        var credits = (calData.attendance || []).length;
        var lastCredit = credits
            ? calData.attendance.slice().sort(function (a, b) {
                return (b.scheduled_date || "").localeCompare(a.scheduled_date || "");
              })[0]
            : null;
        var priorLine = credits
            ? " You have <strong>" + credits + "</strong> prior session" + (credits === 1 ? "" : "s") + " credited" +
              (lastCredit ? " (most recent " + lastCredit.scheduled_date + ")." : ".")
            : "";
        status.innerHTML =
            "<strong class='today-missed'>This session ended without credit.</strong> " +
            "We didn\u2019t see your code in the chat for this briefing." + priorLine +
            " <br><span class='muted' style='font-size:12px;'>" +
            "If you believe you posted a qualifying message, open an appeal from the attendance calendar." +
            "</span>";
        hint.hidden = true;
    }
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}

var calCursor = new Date();
calCursor.setDate(1);
var calData = { attendance: [], appeals: [] };

document.getElementById("cal-prev").addEventListener("click", function () {
    calCursor.setMonth(calCursor.getMonth() - 1);
    renderCalendar();
});
document.getElementById("cal-next").addEventListener("click", function () {
    calCursor.setMonth(calCursor.getMonth() + 1);
    renderCalendar();
});
document.getElementById("cal").addEventListener("click", function (e) {
    var btn = e.target.closest(".cal-appeal-cta");
    if (!btn) return;
    e.stopPropagation();
    showAppealPopover(btn.dataset.date, btn.getBoundingClientRect());
});

function renderCalendar() {
    var grid = document.getElementById("cal");
    grid.innerHTML = "";
    var y = calCursor.getFullYear();
    var m = calCursor.getMonth();
    document.getElementById("cal-label").textContent =
        calCursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

    var headers = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    for (var hi = 0; hi < headers.length; hi++) {
        var d = document.createElement("div");
        d.className = "cal-head";
        d.textContent = headers[hi];
        grid.appendChild(d);
    }

    var credited = new Set();
    for (var ai = 0; ai < calData.attendance.length; ai++) {
        if (calData.attendance[ai].scheduled_date) credited.add(calData.attendance[ai].scheduled_date);
    }
    var appealsByDate = new Map();
    for (var api = 0; api < calData.appeals.length; api++) {
        var ap = calData.appeals[api];
        if (!appealsByDate.has(ap.claimed_date)) appealsByDate.set(ap.claimed_date, []);
        appealsByDate.get(ap.claimed_date).push(ap);
    }

    var firstDow = new Date(y, m, 1).getDay();
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var todayIso = new Date().toISOString().slice(0, 10);

    for (var i = 0; i < firstDow; i++) {
        var cell = document.createElement("div");
        cell.className = "cal-cell cal-empty";
        grid.appendChild(cell);
    }
    for (var day = 1; day <= daysInMonth; day++) {
        var iso = y + "-" + String(m + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
        var cell = document.createElement("div");
        cell.className = "cal-cell";
        if (iso === todayIso) cell.classList.add("cal-today");

        var dots = [];
        if (credited.has(iso)) {
            cell.classList.add("has-credit");
            dots.push('<span class="cal-dot cal-credited" title="credited"></span>');
        }
        var appeals = appealsByDate.get(iso) || [];
        for (var j = 0; j < appeals.length; j++) {
            if (appeals[j].state === "open") {
                cell.classList.add("has-appeal-open");
                dots.push('<span class="cal-dot cal-appeal-open" title="appeal pending"></span>');
            } else if (appeals[j].state === "granted") {
                cell.classList.add("has-appeal-granted");
                dots.push('<span class="cal-dot cal-appeal-granted" title="appeal granted"></span>');
            } else if (appeals[j].state === "denied") {
                cell.classList.add("has-appeal-denied");
                dots.push('<span class="cal-dot cal-appeal-denied" title="appeal denied"></span>');
            }
        }

        var dateObj = new Date(y, m, day);
        var dow = dateObj.getDay();
        var isWeekday = dow >= 1 && dow <= 5;
        var isPast = iso < todayIso;
        var hasCredit = credited.has(iso);
        var hasAppeal = appeals.length > 0;
        var appealEligible = isWeekday && isPast && !hasCredit && !hasAppeal;

        var ctaHtml = appealEligible
            ? '<button type="button" class="cal-appeal-cta" data-date="' + iso + '">appeal?</button>'
            : "";

        cell.innerHTML = '<span class="cal-day">' + day + "</span>" +
            '<span class="cal-dots">' + dots.join("") + ctaHtml + "</span>";
        var titleParts = [];
        if (hasCredit) titleParts.push("credited");
        for (var k = 0; k < appeals.length; k++) titleParts.push("appeal " + appeals[k].state);
        cell.title = titleParts.join(" \u00b7 ") || iso;
        grid.appendChild(cell);
    }
}

// --- Streak tracking ---
function renderStreaks(attendance) {
    if (!attendance.length) return;
    var dateArr = [];
    var seen = {};
    for (var i = 0; i < attendance.length; i++) {
        var sd = attendance[i].scheduled_date;
        if (sd && !seen[sd]) { seen[sd] = true; dateArr.push(sd); }
    }
    dateArr.sort();
    if (!dateArr.length) return;

    var dateSet = {};
    for (var i = 0; i < dateArr.length; i++) dateSet[dateArr[i]] = true;
    var today = new Date().toISOString().slice(0, 10);
    var yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    function prevWeekday(iso) {
        var d = new Date(iso + "T12:00:00Z");
        d.setDate(d.getDate() - 1);
        while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
        return d.toISOString().slice(0, 10);
    }

    var current = 0;
    var cursor = dateSet[today] ? today : dateSet[yesterday] ? yesterday : null;
    if (cursor) {
        while (dateSet[cursor]) {
            current++;
            cursor = prevWeekday(cursor);
        }
    }

    var best = 0, run = 0;
    for (var i = 0; i < dateArr.length; i++) {
        if (i === 0) { run = 1; }
        else {
            var expected = prevWeekday(dateArr[i]);
            run = (dateArr[i - 1] >= expected) ? run + 1 : 1;
        }
        if (run > best) best = run;
    }

    document.getElementById("streak-card").hidden = false;
    document.getElementById("streak-current").textContent = current;
    document.getElementById("streak-best").textContent = best;
}

// --- Renewal countdown tracker ---
var currentCpe = 0;
function renderRenewalTracker(emailPrefs, totalCpe) {
    currentCpe = totalCpe;
    var card = document.getElementById("renewal-card");
    card.hidden = false;
    var tracker = emailPrefs && emailPrefs.renewal_tracker;
    if (tracker && tracker.cert_name && tracker.deadline && tracker.cpe_required) {
        showRenewalDisplay(tracker);
    } else {
        document.getElementById("renewal-display").hidden = true;
        document.getElementById("renewal-setup").hidden = false;
    }
}

function showRenewalDisplay(tracker) {
    document.getElementById("renewal-display").hidden = false;
    document.getElementById("renewal-setup").hidden = true;
    var pct = Math.min(100, (currentCpe / tracker.cpe_required) * 100);
    var bar = document.getElementById("renewal-bar");
    bar.style.width = pct + "%";
    bar.className = "renewal-bar-fill" + (pct >= 100 ? " bar-ok" : pct >= 60 ? "" : " bar-warn");
    document.getElementById("renewal-summary").textContent =
        tracker.cert_name + ": " + currentCpe.toFixed(1) + " / " + tracker.cpe_required + " CPE earned";
    var dl = new Date(tracker.deadline + "T00:00:00");
    var daysLeft = Math.ceil((dl - new Date()) / 86400000);
    var dlStr = dl.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    document.getElementById("renewal-deadline").textContent =
        daysLeft > 0 ? "Deadline: " + dlStr + " (" + daysLeft + " days left)" : "Deadline: " + dlStr + " (past due)";
}

document.getElementById("renewal-edit-btn").addEventListener("click", function () {
    document.getElementById("renewal-display").hidden = true;
    document.getElementById("renewal-setup").hidden = false;
    document.getElementById("renewal-cancel-btn").hidden = false;
});
document.getElementById("renewal-cancel-btn").addEventListener("click", function () {
    document.getElementById("renewal-display").hidden = false;
    document.getElementById("renewal-setup").hidden = true;
});
document.getElementById("renewal-remove-btn").addEventListener("click", async function () {
    if (!confirm("Remove your renewal tracker?")) return;
    var msg = document.getElementById("renewal-msg");
    msg.hidden = false; msg.textContent = "removing...";
    try {
        var r = await fetch("/api/me/" + encodeURIComponent(token) + "/prefs", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ renewal_tracker: null }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        msg.hidden = true;
        document.getElementById("renewal-display").hidden = true;
        document.getElementById("renewal-setup").hidden = false;
        document.getElementById("renewal-form").reset();
    } catch (e) { msg.textContent = "failed: " + e.message; }
});
document.getElementById("renewal-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var msg = document.getElementById("renewal-msg");
    msg.hidden = false; msg.textContent = "saving...";
    var tracker = {
        cert_name: document.getElementById("renewal-cert-name").value.trim(),
        deadline: document.getElementById("renewal-deadline-input").value,
        cpe_required: Number(document.getElementById("renewal-cpe-req").value),
    };
    try {
        var r = await fetch("/api/me/" + encodeURIComponent(token) + "/prefs", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ renewal_tracker: tracker }),
        });
        if (!r.ok) { var j = await r.json().catch(function () { return {}; }); throw new Error(j.error || "HTTP " + r.status); }
        msg.hidden = true;
        document.getElementById("renewal-cancel-btn").hidden = true;
        showRenewalDisplay(tracker);
    } catch (e) { msg.textContent = "failed: " + e.message; }
});

// --- Bulk cert download ---
var allCertsData = [];
document.getElementById("cert-dl-btn").addEventListener("click", async function () {
    var btn = document.getElementById("cert-dl-btn");
    var status = document.getElementById("cert-dl-status");
    btn.disabled = true;
    status.textContent = "Fetching certificates...";
    try {
        if (typeof JSZip === "undefined") throw new Error("ZIP library not loaded \u2014 check your connection");
        var zip = new JSZip();
        var downloadable = allCertsData.filter(function (c) { return c.public_token && (c.state === "delivered" || c.state === "viewed_by_auditor" || c.state === "generated"); });
        var done = 0;
        for (var i = 0; i < downloadable.length; i++) {
            var c = downloadable[i];
            status.textContent = "Downloading " + (++done) + "/" + downloadable.length + "...";
            var url = "/api/download/" + encodeURIComponent(c.public_token);
            var resp = await fetch(url);
            if (!resp.ok) continue;
            var blob = await resp.blob();
            var period = c.period_yyyymm || "cert";
            var kind = c.cert_kind === "per_session" ? "session" : "bundle";
            zip.file("SC-CPE_" + period + "_" + kind + "_" + c.id.slice(-6) + ".pdf", blob);
        }
        status.textContent = "Creating ZIP...";
        var content = await zip.generateAsync({ type: "blob" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(content);
        a.download = "SC-CPE_Certificates.zip";
        a.click();
        URL.revokeObjectURL(a.href);
        status.textContent = "Downloaded " + done + " certificate" + (done === 1 ? "" : "s") + ".";
    } catch (e) {
        status.textContent = "Download failed: " + e.message;
    } finally { btn.disabled = false; }
});

// --- Appeal CTA in calendar ---
var appealPopover = null;
function closeAppealPopover() {
    if (appealPopover) { appealPopover.overlay.remove(); appealPopover.el.remove(); appealPopover = null; }
}
function showAppealPopover(iso, anchorRect) {
    closeAppealPopover();
    var overlay = document.createElement("div");
    overlay.className = "appeal-overlay";
    overlay.addEventListener("click", closeAppealPopover);
    document.body.appendChild(overlay);
    var pop = document.createElement("div");
    pop.className = "appeal-popover";
    pop.innerHTML =
        '<h3>Missed credit for ' + escapeHtml(iso) + '?</h3>' +
        '<p>If you attended the live briefing and didn\u2019t receive credit, file an appeal. An admin will review it.</p>' +
        '<div class="appeal-form">' +
        '<textarea placeholder="What happened? (optional)" maxlength="500" id="appeal-text"></textarea>' +
        '<div class="appeal-actions">' +
        '<button type="button" id="appeal-submit-btn">File appeal</button>' +
        '<button type="button" class="appeal-cancel" id="appeal-close-btn">Cancel</button>' +
        '</div>' +
        '<span id="appeal-msg" class="muted" style="font-size:11px;" hidden></span>' +
        '</div>';
    document.body.appendChild(pop);
    var top = Math.min(anchorRect.bottom + 4, window.innerHeight - pop.offsetHeight - 10);
    var left = Math.min(anchorRect.left, window.innerWidth - pop.offsetWidth - 10);
    pop.style.top = Math.max(10, top) + "px";
    pop.style.left = Math.max(10, left) + "px";
    appealPopover = { el: pop, overlay: overlay };

    pop.querySelector("#appeal-close-btn").addEventListener("click", closeAppealPopover);
    pop.querySelector("#appeal-submit-btn").addEventListener("click", async function () {
        var btn = pop.querySelector("#appeal-submit-btn");
        var msg = pop.querySelector("#appeal-msg");
        btn.disabled = true; msg.hidden = false; msg.textContent = "submitting...";
        try {
            var r = await fetch("/api/me/" + encodeURIComponent(token) + "/appeal", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ claimed_date: iso, evidence_text: pop.querySelector("#appeal-text").value.trim() || null }),
            });
            var j = await r.json().catch(function () { return {}; });
            if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
            msg.textContent = "Appeal filed. An admin will review it.";
            msg.style.color = "var(--ok-soft-text)";
            btn.hidden = true;
            pop.querySelector("#appeal-close-btn").textContent = "Close";
            calData.appeals.push({ id: j.id, claimed_date: iso, state: "open", created_at: new Date().toISOString() });
            renderCalendar();
        } catch (e) {
            msg.textContent = "Failed: " + e.message;
            msg.style.color = "var(--bad-soft-text)";
            btn.disabled = false;
        }
    });
}

// --- Share achievement ---
document.getElementById("share-btn").addEventListener("click", function () {
    var modal = document.getElementById("share-modal");
    var badgeUrl = location.origin + "/api/badge/" + encodeURIComponent(token);
    var pageUrl = location.origin + "/badge.html?t=" + encodeURIComponent(token);
    var cpe = document.getElementById("total").textContent;
    var shareText = "I've earned " + cpe + " attending Simply Cyber's Daily Threat Briefing! Verified via cryptographic audit chain. #SimplyCyber #CPE";

    document.getElementById("share-badge-img").src = badgeUrl;
    document.getElementById("share-url").value = pageUrl;
    document.getElementById("share-text").value = shareText;
    document.getElementById("modal-linkedin").href =
        "https://www.linkedin.com/sharing/share-offsite/?url=" + encodeURIComponent(pageUrl);
    document.getElementById("modal-x").href =
        "https://twitter.com/intent/tweet?text=" + encodeURIComponent(shareText) + "&url=" + encodeURIComponent(pageUrl);
    modal.hidden = false;
});

document.getElementById("share-close").addEventListener("click", function () {
    document.getElementById("share-modal").hidden = true;
});

document.getElementById("share-modal").addEventListener("click", function (e) {
    if (e.target === e.currentTarget) document.getElementById("share-modal").hidden = true;
});

document.getElementById("copy-url-btn").addEventListener("click", async function () {
    var url = document.getElementById("share-url").value;
    var msg = document.getElementById("copy-msg");
    try {
        await navigator.clipboard.writeText(url);
        msg.textContent = "Copied!";
    } catch (e) {
        msg.textContent = "Select and copy manually.";
    }
    msg.hidden = false;
});

document.getElementById("copy-text-btn").addEventListener("click", async function () {
    var text = document.getElementById("share-text").value;
    try {
        await navigator.clipboard.writeText(text);
    } catch (e) {}
});

// --- Remember this device ---
document.getElementById("remember-yes-btn").addEventListener("click", function () {
    saveSession(token, document.getElementById("name").textContent);
    document.getElementById("remember-card").hidden = true;
    document.getElementById("signout-card").hidden = false;
    if (!new URLSearchParams(location.search).get("t")) {
        history.replaceState(null, "", "/dashboard");
    }
});
document.getElementById("remember-no-btn").addEventListener("click", function () {
    document.getElementById("remember-card").hidden = true;
});
document.getElementById("signout-btn").addEventListener("click", function () {
    clearSession();
    location.replace("/dashboard");
});

// --- Leaderboard opt-in ---
document.getElementById("leaderboard-toggle").addEventListener("change", async function (e) {
    var msg = document.getElementById("leaderboard-msg");
    msg.hidden = false;
    msg.textContent = "saving...";
    try {
        var r = await fetch("/api/me/" + encodeURIComponent(token) + "/prefs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ show_on_leaderboard: e.target.checked }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        msg.textContent = e.target.checked ? "You're on the leaderboard!" : "Removed from leaderboard.";
    } catch (err) {
        msg.textContent = "Failed: " + err.message;
        e.target.checked = !e.target.checked;
    }
});

// --- Inline login (no-token state) ---
var loginForm = document.getElementById("login-form");
if (loginForm) {
    loginForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        var btn = loginForm.querySelector("button[type=submit]");
        var loginErr = document.getElementById("login-err");
        var loginOk = document.getElementById("login-ok");
        loginErr.hidden = true;
        loginOk.hidden = true;

        var fd = new FormData(loginForm);
        var turnstileToken = fd.get("cf-turnstile-response");
        if (!turnstileToken) {
            loginErr.textContent = "Please complete the anti-bot challenge.";
            loginErr.hidden = false;
            return;
        }
        btn.disabled = true;
        var original = btn.textContent;
        btn.textContent = "Sending…";
        try {
            var r = await fetch("/api/recover", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: fd.get("email"),
                    turnstile_token: turnstileToken,
                }),
            });
            var data = await r.json();
            if (!r.ok) {
                var msgs = {
                    invalid_email: "That email address doesn’t look right.",
                    captcha_failed: "Anti-bot challenge failed — please try again.",
                };
                loginErr.textContent = msgs[data.error] || "Request failed (" + (data.error || r.status) + ").";
                loginErr.hidden = false;
                return;
            }
            loginForm.hidden = true;
            loginOk.hidden = false;
        } catch (x) {
            loginErr.textContent = "Network error — check your connection and try again.";
            loginErr.hidden = false;
        } finally {
            btn.disabled = false;
            btn.textContent = original;
        }
    });
}

load();
