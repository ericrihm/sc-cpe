var TOKEN = null;
var autoRefreshTimer = null;
var auditEntries = [];

var $ = function (s) { return document.querySelector(s); };
function fmtAge(s) {
  if (s == null) return "—";
  if (s < 90) return s + "s";
  if (s < 5400) return Math.round(s/60) + "m";
  if (s < 86400*2) return Math.round(s/3600) + "h";
  return Math.round(s/86400) + "d";
}
function card(k, v, cls) {
  var n = document.createElement("div");
  n.className = "card";
  n.innerHTML = '<div class="k">' + k + '</div><div class="v ' + (cls||'') + '">' + v + '</div>';
  return n;
}
async function fetchJson(path) {
    var opts = { credentials: "include" };
    if (TOKEN && TOKEN !== "__cookie__") {
        opts.headers = { "Authorization": "Bearer " + TOKEN };
    }
    var r = await fetch(path, opts);
    if (r.status === 401) throw new Error("unauthorized (wrong token?)");
    if (!r.ok) throw new Error(path + " → HTTP " + r.status);
    return r.json();
}
async function postJson(path, body) {
    var opts = {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    };
    if (TOKEN && TOKEN !== "__cookie__") {
        opts.headers["Authorization"] = "Bearer " + TOKEN;
    }
    var r = await fetch(path, opts);
    var j = await r.json().catch(function () { return {}; });
    if (r.status === 401) throw new Error("unauthorized");
    if (!r.ok) throw new Error(j.error || path + " → HTTP " + r.status);
    return j;
}
async function load() {
  $("#err").innerHTML = "";
  try {
    var results = await Promise.all([
      fetchJson("/api/admin/ops-stats"),
      fetchJson("/api/admin/heartbeat-status"),
      fetchJson("/api/admin/audit-chain-verify?limit=200"),
      fetchJson("/api/admin/cert-feedback?rating=typo,wrong&limit=100"),
      fetchJson("/api/admin/toggles"),
      fetchJson("/api/admin/security-events").catch(function () { return null; }),
    ]);
    var stats = results[0], hb = results[1], chain = results[2], fb = results[3], toggles = results[4], secEvents = results[5];
    renderWarnings(stats);
    renderStats(stats);
    renderToggles(toggles);
    renderHeartbeats(hb);
    renderChain(chain, stats);
    renderAuditTrail(chain);
    renderFeedback(fb);
    if (secEvents) renderSecurityEvents(secEvents);
    $("#ts").textContent = "updated " + new Date().toLocaleTimeString();
  } catch (e) {
    $("#err").innerHTML = '<div class="err">' + escapeHtml(e.message) + '</div>';
    if (String(e.message).includes("unauthorized")) {
      $("#app").style.display = "none";
      $("#login").style.display = "";
    }
  }
}
function renderWarnings(s) {
  var box = $("#warnings"); box.innerHTML = "";
  var warnings = s.warnings || [];
  for (var i = 0; i < warnings.length; i++) {
    var w = warnings[i];
    var row = document.createElement("div");
    var isCritical = w.level === "critical";
    row.style.cssText = "padding:8px 14px;border-radius:4px;font-size:13px;border:1px solid;" +
      (isCritical
        ? "background:#3a1818;border-color:#6b2a2a;color:#ffb4b4;"
        : "background:#3a2f18;border-color:#6b5a2a;color:#ffe4a4;");
    row.innerHTML = "<strong>" + (isCritical ? "CRITICAL" : "warn") + '</strong> · <code style="font-size:11px;">' + escapeHtml(w.code) + "</code> — " + escapeHtml(w.detail);
    box.appendChild(row);
  }
}
function renderToggles(d) {
  var box = $("#toggles"); box.innerHTML = "";
  var togglesList = d.toggles || [];
  for (var i = 0; i < togglesList.length; i++) {
    var t = togglesList[i];
    var wrap = document.createElement("div");
    wrap.className = "card";
    wrap.style.padding = "10px 14px";
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "10px";
    wrap.style.minWidth = "240px";
    var label = document.createElement("div");
    label.innerHTML = '<span class="k">/api/' + t.name + '</span><div class="v ' + (t.killed ? "stale" : "ok") + '" style="font-size:14px;">' + (t.killed ? "KILLED (503)" : "live") + '</div>';
    var btn = document.createElement("button");
    btn.className = "refresh";
    btn.style.marginLeft = "auto";
    btn.textContent = t.killed ? "Re-enable" : "Kill";
    if (!t.killed) btn.style.background = "#5c1515";
    (function (t, btn) {
      btn.addEventListener("click", async function () {
        var verb = t.killed ? "re-enable" : "KILL";
        if (!confirm(verb + " /api/" + t.name + "?")) return;
        btn.disabled = true;
        try {
          var r = await fetch("/api/admin/toggles", {
            method: "POST",
            headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ name: t.name, killed: !t.killed }),
          });
          if (!r.ok) throw new Error("toggle → HTTP " + r.status);
          load();
        } catch (e) {
          $("#err").innerHTML = '<div class="err">' + escapeHtml(e.message) + '</div>';
          btn.disabled = false;
        }
      });
    })(t, btn);
    wrap.append(label, btn);
    box.appendChild(wrap);
  }
}
function renderStats(s) {
  var g = $("#stats"); g.innerHTML = "";
  var queuedAge = s.email_outbox.oldest_queued_age_seconds;
  var queuedCls = (queuedAge != null && queuedAge > 600) ? "stale" : "";
  var certPendAge = s.certs ? s.certs.oldest_pending_age_seconds : null;
  var certPendCls = (certPendAge != null && certPendAge > 4 * 3600) ? "stale" : "";
  g.append(
    card("Users (active)", s.users.active),
    card("Users pending", s.users.pending),
    card("Certs 24h", s.last_24h.certs_issued),
    card("Certs total", s.certs_total),
    card("Attendance 24h", s.last_24h.attendance),
    card("Open appeals", s.appeals_open, s.appeals_open > 0 ? "warn" : ""),
    card("Email queued", s.email_outbox.queued + (queuedAge != null ? " · oldest " + fmtAge(queuedAge) : ""), queuedCls),
    card("Email failed", s.email_outbox.failed, s.email_outbox.failed > 0 ? "stale" : ""),
    card("Email sent 24h", s.email_outbox.sent_24h != null ? s.email_outbox.sent_24h : 0),
    card("Certs pending", (s.certs ? s.certs.pending : 0) + (certPendAge != null ? " · oldest " + fmtAge(certPendAge) : ""), certPendCls),
  );
}
function renderHeartbeats(d) {
  var tb = $("#hb tbody"); tb.innerHTML = "";
  for (var i = 0; i < d.sources.length; i++) {
    var s = d.sources[i];
    var tr = document.createElement("tr");
    var cls = s.stale ? "stale" : "ok";
    var status = s.stale ? "STALE" : (s.last_status || "—");
    tr.innerHTML =
      '<td data-label="Source">' + s.source + "</td>" +
      '<td data-label="Status" class="' + cls + '">' + status + "</td>" +
      '<td data-label="Last beat" class="muted">' + (s.last_beat_at || "never") + "</td>" +
      '<td data-label="Age">' + fmtAge(s.age_seconds) + "</td>" +
      '<td data-label="Expected ≤" class="muted">' + (s.expected_s ? (2 * s.expected_s) + "s" : "—") + "</td>" +
      '<td data-label="On duty" class="muted">' + (s.on_duty ? "yes" : "no") + "</td>";
    tb.appendChild(tr);
  }
}
function renderChain(c, s) {
  var g = $("#chain"); g.innerHTML = "";
  g.append(
    card("Chain OK", c.ok ? "YES" : "NO", c.ok ? "ok" : "stale"),
    card("Rows checked", c.rows_checked),
    card("Unique index", c.unique_index_on_prev_hash ? "present" : "MISSING",
         c.unique_index_on_prev_hash ? "ok" : "stale"),
    card("Tip id", '<span class="v small">' + ((s.audit_tip && s.audit_tip.id) || "—") + "</span>"),
    card("Tip ts", '<span class="v small">' + ((s.audit_tip && s.audit_tip.ts) || "—") + "</span>"),
  );
  if (c.first_break) {
    var n = document.createElement("div");
    n.className = "err";
    n.textContent = "Chain break at " + c.first_break.id + " (" + c.first_break.ts + "): expected " + c.first_break.expected_prev_hash + ", got " + c.first_break.actual_prev_hash;
    g.appendChild(n);
  }
}
function renderFeedback(fb) {
  var tb = $("#fb tbody"); tb.innerHTML = "";
  var empty = $("#fb-empty");
  if (!fb.rows || fb.rows.length === 0) {
    empty.hidden = false;
    $("#fb").style.display = "none";
    return;
  }
  empty.hidden = true;
  $("#fb").style.display = "";
  for (var i = 0; i < fb.rows.length; i++) {
    var r = fb.rows[i];
    var tr = document.createElement("tr");
    var ratingCls = r.rating === "wrong" ? "stale" : "warn";
    var action = r.reissue_pending
      ? '<span class="muted">reissue pending</span>'
      : '<button class="refresh reissue-btn" data-cert="' + r.cert_id + '">Re-issue</button>';
    tr.innerHTML =
      '<td class="muted">' + escapeHtml(r.updated_at) + "</td>" +
      '<td class="' + ratingCls + '">' + escapeHtml(r.rating) + "</td>" +
      "<td>" + escapeHtml(r.legal_name) + '<br><span class="muted" style="font-size:11px;">' + escapeHtml(r.email) + "</span></td>" +
      '<td><a href="/verify.html?t=' + encodeURIComponent(r.public_token) + '" target="_blank" rel="noopener" style="color:#7cc3ff;">' + escapeHtml(r.cert_id.slice(0,10)) + '…</a></td>' +
      '<td class="muted">' + escapeHtml(r.period_yyyymm) + "</td>" +
      '<td class="muted">' + escapeHtml(r.cert_kind) + "</td>" +
      '<td class="muted" style="max-width:240px;word-break:break-word;">' + escapeHtml(r.note || "") + "</td>" +
      "<td>" + action + "</td>";
    tb.appendChild(tr);
  }
}
$("#fb tbody").addEventListener("click", async function (e) {
  var btn = e.target.closest(".reissue-btn");
  if (!btn || btn.disabled) return;
  var reason = prompt("Reason for re-issue? (required, max 500 chars)");
  if (!reason) return;
  btn.disabled = true; btn.textContent = "queueing…";
  try {
    var r = await fetch("/api/admin/cert/" + encodeURIComponent(btn.dataset.cert) + "/reissue", {
      method: "POST",
      headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason }),
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    btn.outerHTML = '<span class="muted">reissue queued</span>';
  } catch (err) {
    btn.disabled = false; btn.textContent = "retry";
    btn.title = String(err.message || err);
  }
});
function renderSecurityEvents(d) {
  var box = $("#sec-events"); if (!box) return;
  box.innerHTML = "";
  var total = d.total_events_24h || 0;
  var summary = document.createElement("div");
  summary.style.cssText = "display:flex;gap:12px;align-items:center;margin-bottom:12px;";
  var totalBadge = document.createElement("span");
  totalBadge.style.cssText = "font-size:2rem;font-weight:700;" + (total > 0 ? "color:var(--bad);" : "color:var(--ok);");
  totalBadge.textContent = total;
  var totalLabel = document.createElement("span");
  totalLabel.className = "muted";
  totalLabel.textContent = "rate limit trips + auth failures (24h)";
  summary.append(totalBadge, totalLabel);
  box.appendChild(summary);
  if (total === 0) {
    var quiet = document.createElement("p");
    quiet.className = "muted";
    quiet.style.fontSize = "12px";
    quiet.textContent = "No security events in the last 24 hours.";
    box.appendChild(quiet);
    return;
  }
  var events = d.events || {};
  var keys = Object.keys(events).sort(function (a, b) { return events[b].total_24h - events[a].total_24h; });
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var ev = events[k];
    var row = document.createElement("div");
    row.className = "sec-event-row";
    var label = document.createElement("div");
    label.className = "sec-event-label";
    label.textContent = k.replace("rl_trip:", "").replace("auth_fail:", "auth fail: ");
    var count = document.createElement("div");
    count.className = "sec-event-count";
    count.textContent = ev.total_24h;
    var sparkLine = document.createElement("div");
    sparkLine.className = "sec-spark";
    var hourly = ev.hourly || [];
    var maxVal = 1;
    for (var j = 0; j < hourly.length; j++) { if (hourly[j].count > maxVal) maxVal = hourly[j].count; }
    for (var j = 0; j < Math.min(hourly.length, 24); j++) {
      var bar = document.createElement("div");
      bar.className = "sec-bar";
      var pct = Math.max(2, (hourly[j].count / maxVal) * 100);
      bar.style.height = pct + "%";
      bar.title = hourly[j].hour + ": " + hourly[j].count;
      if (hourly[j].count > 0) bar.style.background = "var(--bad)";
      sparkLine.appendChild(bar);
    }
    row.append(label, count, sparkLine);
    box.appendChild(row);
  }
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}
function renderAuditTrail(chain) {
  var box = $("#audit-rows"); box.innerHTML = "";
  auditEntries = [];
  if (chain.rows && chain.rows.length > 0) {
    auditEntries = chain.rows;
  } else {
    var entries = [];
    if (chain.first_break) {
      entries.push({
        id: chain.first_break.id,
        action: "chain_break",
        entity_type: "audit_chain",
        entity_id: chain.first_break.id,
        actor_type: "system",
        ts: chain.first_break.ts,
        detail: "expected " + (chain.first_break.expected_prev_hash || "null") + ", got " + (chain.first_break.actual_prev_hash || "null")
      });
    }
    entries.push({
      id: "summary",
      action: chain.ok ? "chain_verified" : "chain_broken",
      entity_type: "audit_chain",
      entity_id: "verify",
      actor_type: "system",
      ts: new Date().toISOString(),
      detail: chain.rows_checked + " rows checked, unique index " + (chain.unique_index_on_prev_hash ? "present" : "MISSING")
    });
    auditEntries = entries;
  }
  for (var i = 0; i < auditEntries.length; i++) {
    var entry = auditEntries[i];
    var row = document.createElement("div");
    row.className = "audit-row";
    row.dataset.action = (entry.action || "").toLowerCase();
    row.dataset.entityType = (entry.entity_type || "").toLowerCase();
    row.dataset.entityId = String(entry.entity_id || "").toLowerCase();
    row.dataset.actorType = (entry.actor_type || "").toLowerCase();
    row.dataset.ts = entry.ts || "";
    row.innerHTML =
      '<div><div class="ar-label">Action</div><div class="ar-val">' + escapeHtml(entry.action) + '</div></div>' +
      '<div><div class="ar-label">Entity</div><div class="ar-val">' + escapeHtml(entry.entity_type) + ':' + escapeHtml(entry.entity_id) + '</div></div>' +
      '<div><div class="ar-label">Actor</div><div class="ar-val">' + escapeHtml(entry.actor_type) + (entry.actor_id ? ':' + escapeHtml(entry.actor_id) : '') + '</div></div>' +
      '<div><div class="ar-label">Timestamp</div><div class="ar-val">' + escapeHtml(entry.ts) + '</div></div>' +
      (entry.detail ? '<div style="grid-column:1/-1;"><div class="ar-label">Detail</div><div class="ar-val">' + escapeHtml(entry.detail) + '</div></div>' : '');
    box.appendChild(row);
  }
  filterAuditRows();
}
function filterAuditRows() {
  var q = ($("#audit-q").value || "").toLowerCase().trim();
  var fromDate = $("#audit-from").value;
  var toDate = $("#audit-to").value;
  var rows = document.querySelectorAll("#audit-rows .audit-row");
  var shown = 0;
  var total = rows.length;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var match = true;
    if (q) {
      var text = row.dataset.action + " " + row.dataset.entityType + " " + row.dataset.entityId + " " + row.dataset.actorType;
      if (text.indexOf(q) === -1) match = false;
    }
    if (match && fromDate && row.dataset.ts) {
      if (row.dataset.ts.slice(0, 10) < fromDate) match = false;
    }
    if (match && toDate && row.dataset.ts) {
      if (row.dataset.ts.slice(0, 10) > toDate) match = false;
    }
    if (match) { row.classList.remove("hidden"); shown++; }
    else { row.classList.add("hidden"); }
  }
  $("#audit-count").textContent = total > 0 ? "Showing " + shown + " of " + total + " entries" : "";
}
$("#audit-q").addEventListener("input", filterAuditRows);
$("#audit-from").addEventListener("change", filterAuditRows);
$("#audit-to").addEventListener("change", filterAuditRows);
$("#auto-refresh").addEventListener("change", function() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  if (this.checked) { autoRefreshTimer = setInterval(load, 30000); }
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
$("#refresh").addEventListener("click", load);
var userSearchForm = $("#user-search-form");
if (userSearchForm) {
    userSearchForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        var q = $("#user-q").value.trim();
        var errEl = $("#user-search-err");
        errEl.hidden = true;
        if (q.length < 2) {
            errEl.textContent = "Query must be at least 2 characters.";
            errEl.hidden = false;
            return;
        }
        var btn = userSearchForm.querySelector("button");
        btn.disabled = true;
        btn.textContent = "Searching…";
        try {
            var data = await fetchJson("/api/admin/users?q=" + encodeURIComponent(q) + "&limit=20");
            renderUserResults(data.users || []);
        } catch (err) {
            errEl.textContent = err.message;
            errEl.hidden = false;
        } finally {
            btn.disabled = false;
            btn.textContent = "Search";
        }
    });
}

function renderUserResults(users) {
    var box = $("#user-results");
    box.textContent = "";
    if (users.length === 0) {
        var p = document.createElement("p");
        p.className = "muted";
        p.style.fontSize = "12px";
        p.textContent = "No users found.";
        box.appendChild(p);
        return;
    }
    for (var i = 0; i < users.length; i++) {
        var u = users[i];
        box.appendChild(buildUserRow(u));
    }
}

function buildUserRow(u) {
    var row = document.createElement("div");
    row.className = "user-row";

    var header = document.createElement("div");
    header.className = "user-header";
    var nameSpan = document.createElement("span");
    nameSpan.className = "user-name";
    nameSpan.textContent = u.legal_name;
    var emailSpan = document.createElement("span");
    emailSpan.className = "muted";
    emailSpan.style.fontSize = "12px";
    emailSpan.textContent = u.email;
    var stateSpan = document.createElement("span");
    stateSpan.className = u.state === "active" ? "ok" : (u.deleted_at ? "stale" : "warn");
    stateSpan.style.fontSize = "12px";
    stateSpan.textContent = u.state;
    header.append(nameSpan, emailSpan, stateSpan);

    var meta = document.createElement("div");
    meta.className = "user-meta";
    var idEl = document.createElement("span");
    var idCode = document.createElement("code");
    idCode.textContent = u.id;
    idEl.textContent = "ID: ";
    idEl.appendChild(idCode);
    meta.appendChild(idEl);
    if (u.yt_channel_id) {
        var ytSpan = document.createElement("span");
        ytSpan.textContent = "YT: " + (u.yt_display_name_seen || u.yt_channel_id);
        meta.appendChild(ytSpan);
    }
    var attSpan = document.createElement("span");
    attSpan.textContent = "Attendance: " + u.attendance_count;
    meta.appendChild(attSpan);
    var certSpan = document.createElement("span");
    certSpan.textContent = "Certs: " + u.cert_count;
    meta.appendChild(certSpan);
    if (u.open_appeal_count > 0) {
        var appSpan = document.createElement("span");
        appSpan.className = "warn";
        appSpan.textContent = "Appeals: " + u.open_appeal_count;
        meta.appendChild(appSpan);
    }

    var actions = document.createElement("div");
    actions.className = "user-actions";
    var certsBtn = document.createElement("button");
    certsBtn.className = "refresh view-certs-btn";
    certsBtn.dataset.uid = u.id;
    certsBtn.style.cssText = "font-size:11px;padding:3px 10px;";
    certsBtn.textContent = "View certs (" + u.cert_count + ")";
    var grantBtn = document.createElement("button");
    grantBtn.className = "refresh grant-att-btn";
    grantBtn.dataset.uid = u.id;
    grantBtn.style.cssText = "font-size:11px;padding:3px 10px;";
    grantBtn.textContent = "Grant attendance";
    actions.append(certsBtn, grantBtn);

    var expand = document.createElement("div");
    expand.className = "cert-expand";
    expand.id = "certs-" + u.id;

    row.append(header, meta, actions, expand);
    return row;
}

function renderCertSubTable(container, certs) {
    container.textContent = "";
    if (certs.length === 0) {
        var p = document.createElement("p");
        p.className = "muted";
        p.style.cssText = "font-size:12px;margin:6px 0;";
        p.textContent = "No certs.";
        container.appendChild(p);
        return;
    }
    var table = document.createElement("table");
    table.className = "cert-sub-table";
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    ["Period", "Kind", "State", "CPE", "Token", "Actions"].forEach(function (t) {
        var th = document.createElement("th");
        th.textContent = t;
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    for (var i = 0; i < certs.length; i++) {
        var c = certs[i];
        var tr = document.createElement("tr");
        var tdPeriod = document.createElement("td");
        tdPeriod.textContent = c.period_yyyymm;
        var tdKind = document.createElement("td");
        tdKind.textContent = c.cert_kind;
        var tdState = document.createElement("td");
        tdState.className = c.state === "revoked" ? "stale" : (c.state === "delivered" || c.state === "generated" ? "ok" : "muted");
        tdState.textContent = c.state;
        var tdCpe = document.createElement("td");
        tdCpe.textContent = c.cpe_total;
        var tdToken = document.createElement("td");
        tdToken.className = "muted";
        tdToken.style.cssText = "font-family:monospace;font-size:11px;";
        tdToken.textContent = c.public_token.slice(0, 12) + "…";
        var tdActions = document.createElement("td");
        tdActions.className = "cert-actions";
        if (c.state !== "revoked" && c.state !== "regenerated" && c.state !== "pending") {
            var resendBtn = document.createElement("button");
            resendBtn.className = "refresh cert-resend-btn";
            resendBtn.dataset.token = c.public_token;
            resendBtn.textContent = "Resend";
            var revokeBtn = document.createElement("button");
            revokeBtn.className = "refresh cert-revoke-btn";
            revokeBtn.dataset.token = c.public_token;
            revokeBtn.style.background = "#5c1515";
            revokeBtn.textContent = "Revoke";
            var reissueBtn = document.createElement("button");
            reissueBtn.className = "refresh cert-reissue-btn";
            reissueBtn.dataset.certid = c.id;
            reissueBtn.textContent = "Re-issue";
            tdActions.append(resendBtn, revokeBtn, reissueBtn);
        } else {
            var statusSpan = document.createElement("span");
            statusSpan.className = c.state === "revoked" ? "stale" : "muted";
            statusSpan.textContent = c.state === "pending" ? "pending" : (c.state === "revoked" ? "revoked" : "superseded");
            tdActions.appendChild(statusSpan);
        }
        tr.append(tdPeriod, tdKind, tdState, tdCpe, tdToken, tdActions);
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);
}

var userResultsBox = $("#user-results");
if (userResultsBox) {
    userResultsBox.addEventListener("click", async function (e) {
        var certsBtn = e.target.closest(".view-certs-btn");
        if (certsBtn && !certsBtn.disabled) {
            var uid = certsBtn.dataset.uid;
            var expandEl = document.getElementById("certs-" + uid);
            if (expandEl.childNodes.length > 0) { expandEl.textContent = ""; return; }
            certsBtn.disabled = true;
            certsBtn.textContent = "Loading…";
            try {
                var data = await fetchJson("/api/admin/user/" + encodeURIComponent(uid) + "/certs");
                renderCertSubTable(expandEl, data.certs || []);
            } catch (err) {
                expandEl.textContent = "";
                var errDiv = document.createElement("div");
                errDiv.className = "err";
                errDiv.textContent = err.message;
                expandEl.appendChild(errDiv);
            } finally {
                certsBtn.disabled = false;
                certsBtn.textContent = "View certs";
            }
            return;
        }
        var attBtn = e.target.closest(".grant-att-btn");
        if (attBtn) {
            var attField = $("#att-user-id");
            if (attField) {
                attField.value = attBtn.dataset.uid;
                attField.scrollIntoView({ behavior: "smooth" });
            }
            return;
        }
        var resendBtn = e.target.closest(".cert-resend-btn");
        if (resendBtn && !resendBtn.disabled) {
            if (!confirm("Resend cert email?")) return;
            resendBtn.disabled = true;
            resendBtn.textContent = "sending…";
            try {
                await postJson("/api/admin/cert/" + encodeURIComponent(resendBtn.dataset.token) + "/resend", {});
                var sentSpan = document.createElement("span");
                sentSpan.className = "ok";
                sentSpan.style.fontSize = "11px";
                sentSpan.textContent = "sent";
                resendBtn.replaceWith(sentSpan);
            } catch (err) {
                resendBtn.disabled = false;
                resendBtn.textContent = "retry";
                resendBtn.title = err.message;
            }
            return;
        }
        var revBtn = e.target.closest(".cert-revoke-btn");
        if (revBtn && !revBtn.disabled) {
            var reason = prompt("Reason for revocation? (required)");
            if (!reason) return;
            revBtn.disabled = true;
            revBtn.textContent = "revoking…";
            try {
                await postJson("/api/admin/revoke", { public_token: revBtn.dataset.token, reason: reason });
                var revokedSpan = document.createElement("span");
                revokedSpan.className = "stale";
                revokedSpan.style.fontSize = "11px";
                revokedSpan.textContent = "revoked";
                revBtn.replaceWith(revokedSpan);
            } catch (err) {
                revBtn.disabled = false;
                revBtn.textContent = "retry";
                revBtn.title = err.message;
            }
            return;
        }
        var reissueBtn = e.target.closest(".cert-reissue-btn");
        if (reissueBtn && !reissueBtn.disabled) {
            var reissueReason = prompt("Reason for re-issue? (required)");
            if (!reissueReason) return;
            reissueBtn.disabled = true;
            reissueBtn.textContent = "queueing…";
            try {
                await postJson("/api/admin/cert/" + encodeURIComponent(reissueBtn.dataset.certid) + "/reissue", { reason: reissueReason });
                var queuedSpan = document.createElement("span");
                queuedSpan.className = "muted";
                queuedSpan.style.fontSize = "11px";
                queuedSpan.textContent = "reissue queued";
                reissueBtn.replaceWith(queuedSpan);
            } catch (err) {
                reissueBtn.disabled = false;
                reissueBtn.textContent = "retry";
                reissueBtn.title = err.message;
            }
            return;
        }
    });
}
var revokeForm = $("#revoke-form");
if (revokeForm) {
    revokeForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        var tokenVal = $("#revoke-token").value.trim();
        var reasonVal = $("#revoke-reason").value.trim();
        var resultEl = $("#revoke-result");
        if (!tokenVal || tokenVal.length < 32) {
            resultEl.className = "result-box error";
            resultEl.textContent = "Token must be at least 32 characters.";
            resultEl.hidden = false;
            return;
        }
        if (!reasonVal) {
            resultEl.className = "result-box error";
            resultEl.textContent = "Reason is required.";
            resultEl.hidden = false;
            return;
        }
        if (!confirm("Revoke cert " + tokenVal.slice(0, 12) + "…?")) return;
        var btn = revokeForm.querySelector("button");
        btn.disabled = true;
        btn.textContent = "Revoking…";
        try {
            var data = await postJson("/api/admin/revoke", { public_token: tokenVal, reason: reasonVal });
            resultEl.className = "result-box success";
            resultEl.textContent = data.already_revoked
                ? "Already revoked at " + data.revoked_at
                : "Revoked cert " + data.cert_id + " at " + data.revoked_at;
            resultEl.hidden = false;
            revokeForm.reset();
        } catch (err) {
            resultEl.className = "result-box error";
            resultEl.textContent = err.message;
            resultEl.hidden = false;
        } finally {
            btn.disabled = false;
            btn.textContent = "Revoke";
        }
    });
}
async function loadAppeals() {
    var state = $("#appeals-state-filter").value;
    var box = $("#appeals-rows");
    box.textContent = "";
    var empty = $("#appeals-empty");
    empty.hidden = true;
    try {
        var data = await fetchJson("/api/admin/appeals?state=" + encodeURIComponent(state) + "&limit=50");
        var appeals = data.appeals || [];
        var badge = $("#appeals-count-badge");
        if (badge) badge.textContent = appeals.length > 0 ? "(" + appeals.length + ")" : "";
        if (appeals.length === 0) { empty.hidden = false; return; }
        for (var i = 0; i < appeals.length; i++) {
            box.appendChild(buildAppealRow(appeals[i]));
        }
    } catch (err) {
        var errDiv = document.createElement("div");
        errDiv.className = "err";
        errDiv.textContent = err.message;
        box.appendChild(errDiv);
    }
}

function buildAppealRow(a) {
    var row = document.createElement("div");
    row.className = "appeal-row";

    var dateDiv = document.createElement("div");
    var dateLbl = document.createElement("div");
    dateLbl.className = "ar-label";
    dateLbl.textContent = "Date";
    var dateVal = document.createElement("div");
    dateVal.className = "ar-val";
    dateVal.textContent = a.claimed_date;
    dateDiv.append(dateLbl, dateVal);

    var userDiv = document.createElement("div");
    var userLbl = document.createElement("div");
    userLbl.className = "ar-label";
    userLbl.textContent = "User";
    var userVal = document.createElement("div");
    userVal.className = "ar-val";
    userVal.textContent = a.legal_name;
    var userEmail = document.createElement("span");
    userEmail.className = "muted";
    userEmail.style.fontSize = "11px";
    userEmail.textContent = a.email;
    var br = document.createElement("br");
    userVal.append(br, userEmail);
    userDiv.append(userLbl, userVal);

    var streamDiv = document.createElement("div");
    var streamLbl = document.createElement("div");
    streamLbl.className = "ar-label";
    streamLbl.textContent = "Stream";
    var streamVal = document.createElement("div");
    streamVal.className = "ar-val";
    streamVal.textContent = a.stream_title || a.claimed_stream_id || "—";
    streamDiv.append(streamLbl, streamVal);

    var stateDiv = document.createElement("div");
    var stateLbl = document.createElement("div");
    stateLbl.className = "ar-label";
    stateLbl.textContent = "State";
    var stateVal = document.createElement("div");
    stateVal.className = "ar-val " + (a.state === "open" ? "warn" : (a.state === "granted" ? "ok" : "stale"));
    stateVal.textContent = a.state;
    stateDiv.append(stateLbl, stateVal);

    row.append(dateDiv, userDiv, streamDiv, stateDiv);

    if (a.evidence_text) {
        var evDiv = document.createElement("div");
        evDiv.style.gridColumn = "1 / -1";
        var evLbl = document.createElement("div");
        evLbl.className = "ar-label";
        evLbl.textContent = "Evidence";
        var evVal = document.createElement("div");
        evVal.className = "ar-val";
        evVal.textContent = a.evidence_text;
        evDiv.append(evLbl, evVal);
        row.appendChild(evDiv);
    }

    if (a.evidence_url) {
        var urlDiv = document.createElement("div");
        urlDiv.style.gridColumn = "1 / -1";
        var urlLbl = document.createElement("div");
        urlLbl.className = "ar-label";
        urlLbl.textContent = "Evidence URL";
        var urlVal = document.createElement("div");
        urlVal.className = "ar-val";
        var link = document.createElement("a");
        link.href = a.evidence_url;
        link.target = "_blank";
        link.rel = "noopener";
        link.style.color = "#7cc3ff";
        link.textContent = a.evidence_url;
        urlVal.appendChild(link);
        urlDiv.append(urlLbl, urlVal);
        row.appendChild(urlDiv);
    }

    if (a.state === "open") {
        var actionsDiv = document.createElement("div");
        actionsDiv.className = "appeal-actions";
        var grantBtn = document.createElement("button");
        grantBtn.className = "refresh appeal-grant-btn";
        grantBtn.dataset.aid = a.id;
        grantBtn.textContent = "Grant";
        var denyBtn = document.createElement("button");
        denyBtn.className = "refresh appeal-deny-btn";
        denyBtn.dataset.aid = a.id;
        denyBtn.style.background = "#5c1515";
        denyBtn.textContent = "Deny";
        actionsDiv.append(grantBtn, denyBtn);
        row.appendChild(actionsDiv);
    } else if (a.resolution_notes) {
        var resDiv = document.createElement("div");
        resDiv.style.gridColumn = "1 / -1";
        var resLbl = document.createElement("div");
        resLbl.className = "ar-label";
        resLbl.textContent = "Resolution";
        var resVal = document.createElement("div");
        resVal.className = "ar-val";
        resVal.textContent = (a.resolved_by || "") + ": " + a.resolution_notes + " (" + (a.resolved_at || "") + ")";
        resDiv.append(resLbl, resVal);
        row.appendChild(resDiv);
    }

    return row;
}

var appealsRefreshBtn = $("#appeals-refresh");
if (appealsRefreshBtn) appealsRefreshBtn.addEventListener("click", loadAppeals);
var appealsFilter = $("#appeals-state-filter");
if (appealsFilter) appealsFilter.addEventListener("change", loadAppeals);

var appealsBox = $("#appeals-rows");
if (appealsBox) {
    appealsBox.addEventListener("click", async function (e) {
        var grantBtn = e.target.closest(".appeal-grant-btn");
        var denyBtn = e.target.closest(".appeal-deny-btn");
        var btn = grantBtn || denyBtn;
        if (!btn || btn.disabled) return;
        var decision = grantBtn ? "grant" : "deny";
        var resolver = prompt("Your admin handle:");
        if (!resolver) return;
        var notes = prompt("Resolution notes (optional):") || "";
        var body = { decision: decision, resolver: resolver, notes: notes };
        if (decision === "grant") {
            var rv = prompt("Rule version (default 1):", "1");
            body.rule_version = parseInt(rv, 10) || 1;
        }
        btn.disabled = true;
        btn.textContent = decision === "grant" ? "Granting…" : "Denying…";
        try {
            await postJson("/api/admin/appeals/" + encodeURIComponent(btn.dataset.aid) + "/resolve", body);
            loadAppeals();
        } catch (err) {
            btn.disabled = false;
            btn.textContent = decision === "grant" ? "Grant" : "Deny";
            btn.title = err.message;
            alert("Error: " + err.message);
        }
    });
}
var attendanceForm = $("#attendance-form");
if (attendanceForm) {
    attendanceForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        var resultEl = $("#attendance-result");
        resultEl.hidden = true;
        var body = {
            user_id: $("#att-user-id").value.trim(),
            stream_id: $("#att-stream-id").value.trim(),
            reason: $("#att-reason").value.trim(),
            resolver: $("#att-resolver").value.trim(),
            rule_version: parseInt($("#att-rule-version").value, 10) || 1,
        };
        if (!body.user_id || body.user_id.length < 10) {
            resultEl.className = "result-box error";
            resultEl.textContent = "User ID required.";
            resultEl.hidden = false;
            return;
        }
        if (!body.stream_id || body.stream_id.length < 10) {
            resultEl.className = "result-box error";
            resultEl.textContent = "Stream ID required.";
            resultEl.hidden = false;
            return;
        }
        if (!body.reason) {
            resultEl.className = "result-box error";
            resultEl.textContent = "Reason required.";
            resultEl.hidden = false;
            return;
        }
        if (!body.resolver) {
            resultEl.className = "result-box error";
            resultEl.textContent = "Resolver handle required.";
            resultEl.hidden = false;
            return;
        }
        if (!confirm("Grant attendance for user " + body.user_id.slice(0, 10) + "…?")) return;
        var btn = attendanceForm.querySelector("button");
        btn.disabled = true;
        btn.textContent = "Granting…";
        try {
            var data = await postJson("/api/admin/attendance", body);
            resultEl.className = "result-box success";
            resultEl.textContent = "Attendance granted. Earned CPE: " + data.earned_cpe + ". Source: " + data.source;
            resultEl.hidden = false;
            attendanceForm.reset();
            $("#att-rule-version").value = "1";
        } catch (err) {
            resultEl.className = "result-box error";
            resultEl.textContent = err.message;
            resultEl.hidden = false;
        } finally {
            btn.disabled = false;
            btn.textContent = "Grant attendance";
        }
    });
}
(async function init() {
    try {
        var testR = await fetch("/api/admin/ops-stats", { credentials: "include" });
        if (testR.ok) {
            TOKEN = "__cookie__";
            $("#login").style.display = "none";
            $("#app").style.display = "";
            load();
            loadAppeals();
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
                        redirect: location.pathname,
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
