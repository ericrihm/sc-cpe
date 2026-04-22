var TOKEN = null;
var autoRefreshTimer = null;
var auditEntries = [];

var $ = function (s) { return document.querySelector(s); };
function fmtAge(s) {
  if (s == null) return "\u2014";
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
  var r = await fetch(path, { headers: { "Authorization": "Bearer " + TOKEN } });
  if (r.status === 401) throw new Error("unauthorized (wrong token?)");
  if (!r.ok) throw new Error(path + " \u2192 HTTP " + r.status);
  return r.json();
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
    ]);
    var stats = results[0], hb = results[1], chain = results[2], fb = results[3], toggles = results[4];
    renderWarnings(stats);
    renderStats(stats);
    renderToggles(toggles);
    renderHeartbeats(hb);
    renderChain(chain, stats);
    renderAuditTrail(chain);
    renderFeedback(fb);
    $("#ts").textContent = "updated " + new Date().toLocaleTimeString();
  } catch (e) {
    $("#err").innerHTML = '<div class="err">' + e.message + '</div>';
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
    row.innerHTML = "<strong>" + (isCritical ? "CRITICAL" : "warn") + '</strong> \u00b7 <code style="font-size:11px;">' + w.code + "</code> \u2014 " + w.detail;
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
          if (!r.ok) throw new Error("toggle \u2192 HTTP " + r.status);
          load();
        } catch (e) {
          $("#err").innerHTML = '<div class="err">' + e.message + '</div>';
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
    card("Email queued", s.email_outbox.queued + (queuedAge != null ? " \u00b7 oldest " + fmtAge(queuedAge) : ""), queuedCls),
    card("Email failed", s.email_outbox.failed, s.email_outbox.failed > 0 ? "stale" : ""),
    card("Email sent 24h", s.email_outbox.sent_24h != null ? s.email_outbox.sent_24h : 0),
    card("Certs pending", (s.certs ? s.certs.pending : 0) + (certPendAge != null ? " \u00b7 oldest " + fmtAge(certPendAge) : ""), certPendCls),
  );
}
function renderHeartbeats(d) {
  var tb = $("#hb tbody"); tb.innerHTML = "";
  for (var i = 0; i < d.sources.length; i++) {
    var s = d.sources[i];
    var tr = document.createElement("tr");
    var cls = s.stale ? "stale" : "ok";
    var status = s.stale ? "STALE" : (s.last_status || "\u2014");
    tr.innerHTML =
      '<td data-label="Source">' + s.source + "</td>" +
      '<td data-label="Status" class="' + cls + '">' + status + "</td>" +
      '<td data-label="Last beat" class="muted">' + (s.last_beat_at || "never") + "</td>" +
      '<td data-label="Age">' + fmtAge(s.age_seconds) + "</td>" +
      '<td data-label="Expected \u2264" class="muted">' + (s.expected_s ? (2 * s.expected_s) + "s" : "\u2014") + "</td>" +
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
    card("Tip id", '<span class="v small">' + ((s.audit_tip && s.audit_tip.id) || "\u2014") + "</span>"),
    card("Tip ts", '<span class="v small">' + ((s.audit_tip && s.audit_tip.ts) || "\u2014") + "</span>"),
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
      '<td><a href="/verify.html?t=' + encodeURIComponent(r.public_token) + '" target="_blank" rel="noopener" style="color:#7cc3ff;">' + escapeHtml(r.cert_id.slice(0,10)) + '\u2026</a></td>' +
      '<td class="muted">' + escapeHtml(r.period_yyyymm) + "</td>" +
      '<td class="muted">' + escapeHtml(r.cert_kind) + "</td>" +
      '<td class="muted" style="max-width:240px;word-break:break-word;">' + escapeHtml(r.note || "") + "</td>" +
      "<td>" + action + "</td>";
    tb.appendChild(tr);
  }
  tb.addEventListener("click", async function (e) {
    var btn = e.target.closest(".reissue-btn");
    if (!btn || btn.disabled) return;
    var reason = prompt("Reason for re-issue? (required, max 500 chars)");
    if (!reason) return;
    btn.disabled = true; btn.textContent = "queueing\u2026";
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
$("#go").addEventListener("click", function () {
  TOKEN = $("#token").value.trim();
  if (!TOKEN) return;
  $("#token").value = "";
  $("#login").style.display = "none";
  $("#app").style.display = "";
  load();
});
$("#refresh").addEventListener("click", load);
$("#token").addEventListener("keydown", function (e) { if (e.key === "Enter") $("#go").click(); });
