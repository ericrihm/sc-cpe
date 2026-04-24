// Daily raw-chat purge. Deletes R2 objects for streams past their raw_purge_after
// timestamp. Writes audit_log entry per purged stream and a heartbeat.

export default {
    // Admin-gated on-demand trigger for the scheduled work. Used to verify
    // cron paths without waiting for 09:00 UTC. Bearer-gated against
    // ADMIN_TOKEN; query ?only=security_alerts|weekly_digest|cert_nudge|purge
    // runs just that block. No param = full run.
    async fetch(request, env, ctx) {
        if (!await verifyBearer(request, env)) {
            return new Response(JSON.stringify({ error: "unauthorized" }),
                { status: 401, headers: { "content-type": "application/json" }});
        }
        const now = new Date().toISOString();
        const only = new URL(request.url).searchParams.get("only") || "all";
        const out = {};
        try {
            if (only === "all" || only === "purge") {
                out.purge = await purgeExpired(env, now);
                await heartbeat(env, "purge", "ok", { at: now, ...out.purge });
            }
            if (only === "all" || only === "security_alerts") {
                out.security_alerts = await runSecurityAlerts(env, now);
                await heartbeat(env, "security_alerts", "ok",
                    { at: now, ...out.security_alerts });
            }
            if (only === "all" || only === "weekly_digest") {
                out.weekly_digest = await runWeeklyDigest(env, now);
                await heartbeat(env, "weekly_digest", "ok",
                    { at: now, ...out.weekly_digest });
            }
            if (only === "all" || only === "cert_nudge") {
                out.cert_nudge = await runCertNudges(env, now);
                await heartbeat(env, "cert_nudge", "ok",
                    { at: now, ...out.cert_nudge });
            }
            if (only === "all" || only === "monthly_digest") {
                out.monthly_digest = await runMonthlyDigest(env, now);
                await heartbeat(env, "monthly_digest", "ok",
                    { at: now, ...out.monthly_digest });
            }
            if (only === "all" || only === "renewal_nudge") {
                out.renewal_nudge = await runRenewalNudges(env, now);
                await heartbeat(env, "renewal_nudge", "ok",
                    { at: now, ...out.renewal_nudge });
            }
            if (only === "all" || only === "link_enrichment") {
                out.link_enrichment = await enrichShowLinks(env, now);
                await heartbeat(env, "link_enrichment", "ok",
                    { at: now, ...out.link_enrichment });
            }
            return new Response(JSON.stringify({ ok: true, now, ...out }),
                { headers: { "content-type": "application/json" }});
        } catch (err) {
            return new Response(JSON.stringify({
                ok: false, error: String(err?.message || err),
                stack: String(err?.stack || "").slice(0, 800), partial: out,
            }), { status: 500, headers: { "content-type": "application/json" }});
        }
    },

    async scheduled(event, env, ctx) {
        const now = new Date().toISOString();
        try {
            const purged = await purgeExpired(env, now);
            await heartbeat(env, "purge", "ok", { at: now, purged });
        } catch (err) {
            await heartbeat(env, "purge", "error", {
                at: now,
                msg: String(err && err.message || err),
            });
            throw err;
        }

        // Piggyback a daily security-alert sweep on the purge cron. Scans the
        // audit log for adversarial-signal events since the last alert and
        // emails ADMIN_ALERT_EMAIL if any are found. Isolated from purge so a
        // failure here doesn't fail the purge (and vice versa).
        try {
            const alerted = await runSecurityAlerts(env, now);
            await heartbeat(env, "security_alerts", "ok", { at: now, ...alerted });
        } catch (err) {
            await heartbeat(env, "security_alerts", "error", {
                at: now, msg: String(err && err.message || err),
            });
        }

        // Weekly ops digest — runs only on Mondays (UTC). Also isolated
        // so a failure here doesn't cascade. Uses its own heartbeat row
        // `weekly_digest` which doubles as a "last sent" marker.
        if (new Date(now).getUTCDay() === 1) {
            try {
                const sent = await runWeeklyDigest(env, now);
                await heartbeat(env, "weekly_digest", "ok", { at: now, ...sent });
            } catch (err) {
                await heartbeat(env, "weekly_digest", "error", {
                    at: now, msg: String(err && err.message || err),
                });
            }
        }

        // Monthly cert nudge — fires on the 8th UTC, a week after the
        // monthly-certs cron so users have had time to open the PDF. Enqueues
        // one reminder email per prior-month bundled cert that has no feedback
        // yet; idempotency key prevents duplicates across the 8th's crons.
        if (new Date(now).getUTCDate() === 8) {
            try {
                const nudged = await runCertNudges(env, now);
                await heartbeat(env, "cert_nudge", "ok", { at: now, ...nudged });
            } catch (err) {
                await heartbeat(env, "cert_nudge", "error", {
                    at: now, msg: String(err && err.message || err),
                });
            }
        }

        // Renewal tracker milestone nudges — runs daily. Checks active users
        // with renewal_tracker set and sends one-time emails at 50%, 75%, 90%,
        // and when deadline is within 30 days.
        try {
            const milestoned = await runRenewalNudges(env, now);
            await heartbeat(env, "renewal_nudge", "ok", { at: now, ...milestoned });
        } catch (err) {
            await heartbeat(env, "renewal_nudge", "error", {
                at: now, msg: String(err && err.message || err),
            });
        }

        // Show-link metadata enrichment — runs every day. Fetches page
        // titles for URLs the poller extracted but hasn't enriched yet.
        try {
            const enriched = await enrichShowLinks(env, now);
            await heartbeat(env, "link_enrichment", "ok", { at: now, ...enriched });
        } catch (err) {
            await heartbeat(env, "link_enrichment", "error", {
                at: now, msg: String(err && err.message || err),
            });
        }

        // Monthly user digest — fires on the 1st of each month. Queues a
        // summary email for every active user who earned CPE last month.
        if (new Date(now).getUTCDate() === 1) {
            try {
                const digest = await runMonthlyDigest(env, now);
                await heartbeat(env, "monthly_digest", "ok", { at: now, ...digest });
            } catch (err) {
                await heartbeat(env, "monthly_digest", "error", {
                    at: now, msg: String(err && err.message || err),
                });
            }
        }
    },
};

async function runMonthlyDigest(env, nowIso) {
    if (!env.SITE_BASE) {
        return { skipped: "missing_site_base" };
    }
    const siteBase = env.SITE_BASE.replace(/\/$/, "");

    const d = new Date(nowIso);
    const py = d.getUTCMonth() === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
    const pm = d.getUTCMonth() === 0 ? 12 : d.getUTCMonth(); // 1-12
    const periodYyyymm = `${py}${String(pm).padStart(2, "0")}`;
    const periodStart = `${py}-${String(pm).padStart(2, "0")}-01`;
    const periodEndDate = new Date(Date.UTC(py, pm, 0)); // last day of prior month
    const periodEnd = periodEndDate.toISOString().slice(0, 10);
    const months = ["January","February","March","April","May","June",
        "July","August","September","October","November","December"];
    const periodLabel = `${months[pm - 1]} ${py}`;

    // All active users who earned CPE in the prior month
    const rows = (await env.DB.prepare(`
        SELECT u.id AS user_id, u.email, u.legal_name, u.dashboard_token,
               u.email_prefs,
               SUM(a.earned_cpe) AS month_cpe,
               COUNT(a.stream_id) AS month_sessions
          FROM users u
          JOIN attendance a ON a.user_id = u.id
          JOIN streams s ON s.id = a.stream_id
         WHERE u.state = 'active'
           AND u.deleted_at IS NULL
           AND s.scheduled_date >= ?1
           AND s.scheduled_date <= ?2
      GROUP BY u.id
    `).bind(periodStart, periodEnd).all()).results || [];

    let queued = 0, skipped = 0;
    for (const r of rows) {
        try {
            const prefs = JSON.parse(r.email_prefs || "{}") || {};
            if (prefs.monthly_cert === false) { skipped++; continue; }

            // Total CPE (all time)
            const totalRow = await env.DB.prepare(
                "SELECT SUM(earned_cpe) AS total FROM attendance WHERE user_id = ?1"
            ).bind(r.user_id).first();
            const totalCpe = totalRow?.total || 0;

            // Current streak
            const attRows = (await env.DB.prepare(`
                SELECT s.scheduled_date
                  FROM attendance a JOIN streams s ON s.id = a.stream_id
                 WHERE a.user_id = ?1
              ORDER BY s.scheduled_date DESC
            `).bind(r.user_id).all()).results || [];
            const streak = computeStreak(attRows);

            // Certs issued in the period
            const certRow = await env.DB.prepare(
                "SELECT COUNT(*) AS n FROM certs WHERE user_id = ?1 AND period_yyyymm = ?2 AND state != 'regenerated'"
            ).bind(r.user_id, periodYyyymm).first();
            const certsIssued = certRow?.n || 0;

            const dashUrl = `${siteBase}/dashboard.html?t=${r.dashboard_token}`;
            const subject = `Your SC-CPE Monthly Summary \u2014 ${periodLabel}`;
            const text =
                `Hi ${r.legal_name || "there"},\n\n` +
                `Here's your SC-CPE summary for ${periodLabel}:\n\n` +
                `  CPE earned this month:  ${r.month_cpe}\n` +
                `  Total CPE earned:       ${totalCpe}\n` +
                `  Sessions attended:      ${r.month_sessions}\n` +
                `  Current streak:         ${streak} day${streak !== 1 ? "s" : ""}\n` +
                `  Certificates issued:    ${certsIssued}\n\n` +
                `Dashboard: ${dashUrl}\n\n` +
                `See you at the next Daily Threat Briefing!\n` +
                `\u2014 Simply Cyber CPE\n`;
            const html = emailShell({
                title: `Monthly Summary \u2014 ${periodLabel}`,
                preheader: `${r.month_cpe} CPE earned in ${periodLabel}`,
                bodyHtml:
                    `<p>Hi ${escapeHtml(r.legal_name || "there")},</p>` +
                    `<p>Here's your SC-CPE summary for <strong>${escapeHtml(periodLabel)}</strong>:</p>` +
                    `<table style="border-collapse:collapse;width:100%;margin:16px 0;">` +
                    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e6eaee;color:#5b6473;">CPE earned this month</td><td style="padding:8px 12px;border-bottom:1px solid #e6eaee;font-weight:700;">${r.month_cpe}</td></tr>` +
                    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e6eaee;color:#5b6473;">Total CPE earned</td><td style="padding:8px 12px;border-bottom:1px solid #e6eaee;font-weight:700;">${totalCpe}</td></tr>` +
                    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e6eaee;color:#5b6473;">Sessions attended</td><td style="padding:8px 12px;border-bottom:1px solid #e6eaee;font-weight:700;">${r.month_sessions}</td></tr>` +
                    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e6eaee;color:#5b6473;">Current streak</td><td style="padding:8px 12px;border-bottom:1px solid #e6eaee;font-weight:700;">${streak} day${streak !== 1 ? "s" : ""}</td></tr>` +
                    `<tr><td style="padding:8px 12px;color:#5b6473;">Certificates issued</td><td style="padding:8px 12px;font-weight:700;">${certsIssued}</td></tr>` +
                    `</table>` +
                    `<p><a href="${dashUrl}" style="display:inline-block;padding:12px 24px;background:#0b3d5c;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">View dashboard</a></p>` +
                    `<p style="color:#777;font-size:13px;">See you at the next Daily Threat Briefing!</p>`,
            });

            await env.DB.prepare(`
                INSERT INTO email_outbox
                  (id, user_id, template, to_email, subject, payload_json,
                   idempotency_key, state, attempts, created_at)
                VALUES (?1, ?2, 'monthly_digest', ?3, ?4, ?5, ?6, 'queued', 0, ?7)
            `).bind(
                ulid(), r.user_id, r.email, subject,
                JSON.stringify({ html_body: html, text_body: text }),
                `monthly_digest:${r.user_id}:${periodYyyymm}`, nowIso,
            ).run();
            queued++;
        } catch (err) {
            if (/UNIQUE/i.test(String(err?.message || err))) {
                skipped++;
            } else {
                throw err;
            }
        }
    }
    if (queued > 0) {
        await discordPost(env, env.DISCORD_WEBHOOK,
            `**${queued} CPE certificate${queued === 1 ? "" : "s"}** issued for ${periodLabel}! ` +
            `Check your email for your signed PDF. Verify any cert at ${siteBase}/verify.html`);
    }

    return { period: periodYyyymm, queued, skipped, candidates: rows.length };
}

function computeStreak(rows) {
    const dates = [...new Set(rows.map(r => r.scheduled_date).filter(Boolean))].sort().reverse();
    if (dates.length === 0) return 0;
    let streak = 1;
    for (let i = 1; i < dates.length; i++) {
        const prev = new Date(dates[i - 1]);
        const curr = new Date(dates[i]);
        const diffDays = Math.round((prev - curr) / 86400000);
        if (diffDays <= 3) { streak++; } else { break; }
    }
    return streak;
}

function emailShell({ title, preheader, bodyHtml }) {
    const safeTitle = escapeHtml(title);
    return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f6f8;font-family:Helvetica,Arial,sans-serif;color:#111;line-height:1.5;">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(preheader || "")}</span>
<div style="max-width:580px;margin:0 auto;background:#fff;">
  <div style="background:#0b3d5c;padding:18px 24px;">
    <div style="color:#fff;font-size:11pt;letter-spacing:0.18em;text-transform:uppercase;">Simply Cyber CPE</div>
    <div style="color:#d4a73a;font-size:9pt;margin-top:2px;">${safeTitle}</div>
  </div>
  <div style="padding:24px;">
    ${bodyHtml}
  </div>
  <div style="padding:16px 24px;border-top:1px solid #e6eaee;font-size:11px;color:#777;">
    You're receiving this because you registered for Simply Cyber CPE.<br/>
    Questions? Reply to this email.
  </div>
</div>
</body></html>`;
}

// Prior month as YYYYMM string. Runs on the 8th, so "this month minus one".
function priorPeriodYyyymm(nowIso) {
    const d = new Date(nowIso);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth(); // 0-11; "prior month" = this index
    const py = m === 0 ? y - 1 : y;
    const pm = m === 0 ? 12 : m;
    return `${py}${String(pm).padStart(2, "0")}`;
}

async function runCertNudges(env, nowIso) {
    if (!env.SITE_BASE) {
        return { skipped: "missing_site_base" };
    }
    const period = priorPeriodYyyymm(nowIso);

    // Bundled certs only (per_session recipients already get one email per
    // session — nudging them again would be noise). LEFT JOIN cert_feedback
    // excludes certs the user has already rated.
    const rows = (await env.DB.prepare(`
        SELECT c.id AS cert_id, c.public_token, c.period_yyyymm,
               u.id AS user_id, u.email, u.legal_name, u.dashboard_token,
               u.email_prefs
          FROM certs c
          JOIN users u ON u.id = c.user_id
     LEFT JOIN cert_feedback f ON f.cert_id = c.id
         WHERE c.period_yyyymm = ?1
           AND c.cert_kind = 'bundled'
           AND c.state = 'generated'
           AND u.deleted_at IS NULL
           AND f.cert_id IS NULL
    `).bind(period).all()).results || [];

    let queued = 0, skipped = 0;
    const siteBase = env.SITE_BASE.replace(/\/$/, "");

    for (const r of rows) {
        try {
            const prefs = JSON.parse(r.email_prefs || "{}") || {};
            if (prefs.monthly_cert === false) { skipped++; continue; }

            const verifyUrl = `${siteBase}/verify.html?t=${r.public_token}`;
            const dashUrl = `${siteBase}/dashboard.html?t=${r.dashboard_token}`;
            const subject = `Your ${period} CPE cert — a quick check?`;
            const text =
                `Hi ${r.legal_name || "there"},\n\n` +
                `Your ${period} Simply Cyber DTB CPE certificate was issued ` +
                `last week. Please take a moment to open it and confirm the ` +
                `details are correct:\n\n` +
                `  ${verifyUrl}\n\n` +
                `Dashboard: ${dashUrl}\n\n` +
                `If anything looks wrong (typo in your name, wrong CPE count, ` +
                `etc.) just reply here or use the feedback button on the ` +
                `verify page and we'll re-issue.\n\n` +
                `— Simply Cyber CPE\n`;
            const html =
                `<p>Hi ${escapeHtml(r.legal_name || "there")},</p>` +
                `<p>Your ${escapeHtml(period)} Simply Cyber DTB CPE ` +
                `certificate was issued last week. Please take a moment to ` +
                `open it and confirm the details are correct:</p>` +
                `<p><a href="${verifyUrl}">${verifyUrl}</a></p>` +
                `<p>Dashboard: <a href="${dashUrl}">${dashUrl}</a></p>` +
                `<p>If anything looks wrong (typo in your name, wrong CPE ` +
                `count, etc.) just reply here or use the feedback button on ` +
                `the verify page and we'll re-issue.</p>` +
                `<p>— Simply Cyber CPE</p>`;

            await env.DB.prepare(`
                INSERT INTO email_outbox
                  (id, user_id, template, to_email, subject, payload_json,
                   idempotency_key, state, attempts, created_at)
                VALUES (?1, ?2, 'cert_nudge', ?3, ?4, ?5, ?6, 'queued', 0, ?7)
            `).bind(
                ulid(), r.user_id, r.email, subject,
                JSON.stringify({ html_body: html, text_body: text }),
                `cert_nudge:${r.cert_id}`, nowIso,
            ).run();
            queued++;
        } catch (err) {
            // UNIQUE(idempotency_key) re-fires are expected on 8th re-runs.
            if (/UNIQUE/i.test(String(err?.message || err))) {
                skipped++;
            } else {
                throw err;
            }
        }
    }
    return { period, queued, skipped, candidates: rows.length };
}

const RENEWAL_MILESTONES = [50, 75, 90];
const RENEWAL_DEADLINE_WARN_DAYS = 30;

async function runRenewalNudges(env, nowIso) {
    if (!env.SITE_BASE) return { skipped: "missing_site_base" };
    const siteBase = env.SITE_BASE.replace(/\/$/, "");

    const rows = (await env.DB.prepare(`
        SELECT id, email, legal_name, dashboard_token, email_prefs
          FROM users
         WHERE state = 'active' AND deleted_at IS NULL
           AND email_prefs LIKE '%renewal_tracker%'
    `).all()).results || [];

    let queued = 0, skipped = 0, checked = 0;

    for (const r of rows) {
        let prefs;
        try { prefs = JSON.parse(r.email_prefs || "{}") || {}; } catch { continue; }
        const rt = prefs.renewal_tracker;
        if (!rt || !rt.cert_name || !rt.deadline || !rt.cpe_required) continue;
        checked++;

        const totalRow = await env.DB.prepare(
            "SELECT SUM(earned_cpe) AS total FROM attendance WHERE user_id = ?1"
        ).bind(r.id).first();
        const earned = totalRow?.total || 0;
        const pct = Math.floor((earned / rt.cpe_required) * 100);

        const deadlineMs = new Date(rt.deadline + "T00:00:00Z").getTime();
        const daysLeft = Math.ceil((deadlineMs - Date.parse(nowIso)) / 86400_000);

        for (const milestone of RENEWAL_MILESTONES) {
            if (pct < milestone) continue;
            const idemKey = `renewal_milestone:${r.id}:${milestone}:${rt.cert_name}`;
            const result = await queueRenewalEmail(env, r, rt, earned, milestone, "milestone", daysLeft, siteBase, idemKey, nowIso);
            if (result === "queued") queued++;
            else if (result === "skip") skipped++;
        }

        if (daysLeft > 0 && daysLeft <= RENEWAL_DEADLINE_WARN_DAYS && pct < 100) {
            const idemKey = `renewal_deadline:${r.id}:${rt.deadline}:${rt.cert_name}`;
            const result = await queueRenewalEmail(env, r, rt, earned, pct, "deadline", daysLeft, siteBase, idemKey, nowIso);
            if (result === "queued") queued++;
            else if (result === "skip") skipped++;
        }
    }
    return { checked, queued, skipped };
}

async function queueRenewalEmail(env, user, rt, earned, value, type, daysLeft, siteBase, idemKey, nowIso) {
    const dashUrl = `${siteBase}/dashboard.html?t=${user.dashboard_token}`;
    const name = user.legal_name || "there";

    let subject, text;
    if (type === "milestone") {
        subject = `${rt.cert_name}: ${value}% of CPE earned!`;
        text = `Hi ${name},\n\n` +
            `You've hit ${value}% of the CPE needed for ${rt.cert_name}! ` +
            `${earned} / ${rt.cpe_required} CPE earned` +
            (daysLeft > 0 ? ` with ${daysLeft} days until your deadline.` : ".") +
            `\n\nDashboard: ${dashUrl}\n\n` +
            `Keep it up!\n— Simply Cyber CPE\n`;
    } else {
        subject = `${rt.cert_name}: ${daysLeft} days until deadline`;
        text = `Hi ${name},\n\n` +
            `Your ${rt.cert_name} renewal deadline is ${daysLeft} day${daysLeft === 1 ? "" : "s"} away. ` +
            `You've earned ${earned} / ${rt.cpe_required} CPE (${value}%).\n\n` +
            `Dashboard: ${dashUrl}\n\n` +
            `— Simply Cyber CPE\n`;
    }

    const html = emailShell({
        title: subject,
        preheader: subject,
        bodyHtml:
            `<p>Hi ${escapeHtml(name)},</p>` +
            (type === "milestone"
                ? `<p>You've hit <strong>${value}%</strong> of the CPE needed for <strong>${escapeHtml(rt.cert_name)}</strong>!</p>` +
                  `<p>${earned} / ${rt.cpe_required} CPE earned` + (daysLeft > 0 ? ` — ${daysLeft} days until deadline.` : ".") + `</p>`
                : `<p>Your <strong>${escapeHtml(rt.cert_name)}</strong> renewal deadline is <strong>${daysLeft} day${daysLeft === 1 ? "" : "s"}</strong> away.</p>` +
                  `<p>${earned} / ${rt.cpe_required} CPE earned (${value}%).</p>`) +
            `<p><a href="${dashUrl}" style="display:inline-block;padding:12px 24px;background:#0b3d5c;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">View dashboard</a></p>`,
    });

    try {
        await env.DB.prepare(`
            INSERT INTO email_outbox
              (id, user_id, template, to_email, subject, payload_json,
               idempotency_key, state, attempts, created_at)
            VALUES (?1, ?2, 'renewal_nudge', ?3, ?4, ?5, ?6, 'queued', 0, ?7)
        `).bind(
            ulid(), user.id, user.email, subject,
            JSON.stringify({ html_body: html, text_body: text }),
            idemKey, nowIso,
        ).run();
        return "queued";
    } catch (err) {
        if (/UNIQUE/i.test(String(err?.message || err))) return "skip";
        throw err;
    }
}

function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

// Weekly rollup — one email Monday morning (UTC) covering the prior 7 days.
// Kept intentionally terse: counts only, no row-by-row event lists. Its job
// is "is the system doing its job" at a glance, not forensic detail.
async function runWeeklyDigest(env, nowIso) {
    if (!env.RESEND_API_KEY || !env.FROM_EMAIL || !env.ADMIN_ALERT_EMAIL) {
        return { skipped: "missing_secrets" };
    }
    const since = new Date(Date.parse(nowIso) - 7 * 86400_000).toISOString();

    const [
        regs, verified, attendance, certs, appealsOpened, appealsGranted,
        appealsDenied, emailSent, emailFailed,
    ] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at > ?1").bind(since).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE verified_at > ?1").bind(since).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM attendance WHERE created_at > ?1").bind(since).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM certs WHERE created_at > ?1").bind(since).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM appeals WHERE created_at > ?1").bind(since).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM appeals WHERE resolved_at > ?1 AND state = 'granted'").bind(since).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM appeals WHERE resolved_at > ?1 AND state = 'denied'").bind(since).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE sent_at > ?1 AND state = 'sent'").bind(since).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE state = 'failed'").first(),
    ]);

    const subject = `[SC-CPE] weekly digest — ${since.slice(0, 10)} → ${nowIso.slice(0, 10)}`;
    const text =
        `SC-CPE weekly ops digest\n` +
        `Window: ${since} → ${nowIso}\n\n` +
        `Users registered:     ${regs?.n ?? 0}\n` +
        `Users verified:       ${verified?.n ?? 0}\n` +
        `Attendance rows:      ${attendance?.n ?? 0}\n` +
        `Certs issued:         ${certs?.n ?? 0}\n` +
        `Appeals opened:       ${appealsOpened?.n ?? 0}\n` +
        `Appeals granted:      ${appealsGranted?.n ?? 0}\n` +
        `Appeals denied:       ${appealsDenied?.n ?? 0}\n` +
        `Emails sent:          ${emailSent?.n ?? 0}\n` +
        `Emails failed (all):  ${emailFailed?.n ?? 0}\n\n` +
        `Dashboard: /admin.html\n`;

    const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `weekly-digest:${nowIso.slice(0, 10)}`,
        },
        body: JSON.stringify({
            from: env.FROM_EMAIL,
            to: [env.ADMIN_ALERT_EMAIL],
            subject,
            text,
        }),
    });
    if (resp.status >= 400) {
        const body = (await resp.text()).slice(0, 500);
        throw new Error(`resend_${resp.status}: ${body}`);
    }
    const lbRows = (await env.DB.prepare(`
        SELECT u.legal_name, u.current_streak,
               SUM(a.earned_cpe) AS cpe_earned
          FROM attendance a
          JOIN streams s ON s.id = a.stream_id
          JOIN users u ON u.id = a.user_id
         WHERE u.show_on_leaderboard = 1 AND u.state = 'active' AND u.deleted_at IS NULL
           AND s.scheduled_date >= ?1
      GROUP BY u.id
      ORDER BY cpe_earned DESC LIMIT 5
    `).bind(since.slice(0, 10)).all()).results || [];

    if (lbRows.length > 0) {
        const lines = lbRows.map((r, i) => {
            const parts = (r.legal_name || "").trim().split(/\s+/);
            const first = parts[0] || "User";
            const lastI = parts.length > 1 ? " " + parts[parts.length - 1][0] + "." : "";
            const streak = r.current_streak > 0 ? ` (${r.current_streak}d streak)` : "";
            return `${i + 1}. **${first}${lastI}** — ${r.cpe_earned} CPE${streak}`;
        });
        await discordPost(env, env.DISCORD_WEBHOOK,
            `**Weekly Leaderboard** (${since.slice(0, 10)} → ${nowIso.slice(0, 10)}):\n` +
            lines.join("\n") +
            `\n\nFull leaderboard: ${env.SITE_BASE || "https://sc-cpe-web.pages.dev"}/leaderboard.html`);
    }

    return { window_start: since, sent: true };
}

// Actions we want the admin to see the morning after. Keep this list tight —
// every entry becomes a daily email. Noisy signals (rate-limit hits, expired
// codes) stay out; only facts that suggest a real attempt to subvert the flow.
const ALERT_ACTIONS = [
    "code_race_detected",
    "code_channel_conflict",
    "appeal_granted",  // admin action — useful to see in a daily digest
];

// MIRROR of pages/functions/_heartbeat.js::EXPECTED_CADENCE_S. Keep in sync —
// divergence means the admin UI and the daily digest disagree on what's
// "stale". The purge worker is a separate deploy so we can't share the import.
const EXPECTED_CADENCE_S = {
    poller: 120,
    purge: 90000,
    security_alerts: 90000,
    email_sender: 300,
    canary: 3600,
    monthly_digest: 2678400,
    link_enrichment: 86400,
    cert_nudge: 2678400,
    renewal_nudge: 86400,
};

function staleHeartbeats(rows, nowMs) {
    // The digest runs daily at 09:00 UTC. The ET poll window is 8-11am ET
    // (~12:00-15:00 UTC depending on DST), so at digest time the poller is
    // normally OFF duty. To avoid a noisy "poller stale" every morning we
    // skip the poller in the digest — the admin endpoint has richer context
    // (time-of-day check) and is the right place to see that one.
    const out = [];
    const known = Object.keys(EXPECTED_CADENCE_S).filter(s => s !== "poller");
    const byName = new Map(rows.map(r => [r.source, r]));
    for (const name of known) {
        const expected_s = EXPECTED_CADENCE_S[name];
        const row = byName.get(name);
        if (!row) {
            out.push({ source: name, age_seconds: null, expected_s, reason: "never_beat" });
            continue;
        }
        const age_s = Math.floor((nowMs - new Date(row.last_beat_at).getTime()) / 1000);
        if (age_s > 2 * expected_s) {
            out.push({ source: name, age_seconds: age_s, expected_s, reason: "age_exceeds_2x" });
        }
    }
    return out;
}

async function runSecurityAlerts(env, nowIso) {
    if (!env.RESEND_API_KEY || !env.FROM_EMAIL || !env.ADMIN_ALERT_EMAIL) {
        return { skipped: "missing_secrets" };
    }

    // Use the heartbeats row as our "since" cursor. detail_json.cursor_ts is
    // the ISO timestamp of the newest audit row included in the previous
    // alert. On first run (no row), look back 24h.
    const prev = await env.DB.prepare(
        "SELECT detail_json FROM heartbeats WHERE source = 'security_alerts'"
    ).first();
    let since;
    try { since = JSON.parse(prev?.detail_json || "{}").cursor_ts; } catch { since = null; }
    if (!since) since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    const placeholders = ALERT_ACTIONS.map((_, i) => `?${i + 2}`).join(",");
    const rs = await env.DB.prepare(`
        SELECT id, ts, actor_type, actor_id, action, entity_id, after_json
        FROM audit_log
        WHERE ts > ?1 AND action IN (${placeholders})
        ORDER BY ts ASC
        LIMIT 200
    `).bind(since, ...ALERT_ACTIONS).all();

    const rows = rs.results || [];

    // Stale-heartbeats section. Reads all heartbeats and reports any known
    // source whose age exceeds 2× its expected cadence (poller excluded —
    // see staleHeartbeats comment). Always included in the digest if any
    // are found, even when there are no security events.
    const hbRows = (await env.DB.prepare(
        "SELECT source, last_beat_at, last_status FROM heartbeats",
    ).all()).results || [];
    const stale = staleHeartbeats(hbRows, Date.now());

    if (rows.length === 0 && stale.length === 0) {
        return { scanned_since: since, events: 0, stale_heartbeats: 0 };
    }

    const subject =
        `[SC-CPE] ${rows.length} security event(s)` +
        (stale.length ? `, ${stale.length} stale heartbeat(s)` : "") +
        ` since ${since.slice(0, 16)}`;
    const lines = rows.map(r =>
        `${r.ts}  ${r.action.padEnd(24)}  entity=${r.entity_id}  after=${(r.after_json || "").slice(0, 200)}`
    );
    const staleLines = stale.map(s =>
        `  - ${s.source.padEnd(18)} age=${s.age_seconds ?? "never"}s expected≤${2 * s.expected_s}s (${s.reason})`
    );
    const text =
        `SC-CPE daily security digest\n` +
        `Scanned audit_log since: ${since}\n` +
        `Events: ${rows.length}\n\n` +
        (rows.length ? lines.join("\n") + "\n\n" : "") +
        (stale.length
            ? `Stale heartbeats (${stale.length}):\n` + staleLines.join("\n") + "\n\n"
            : "") +
        `Run /api/admin/audit-chain-verify to confirm chain integrity.\n` +
        `Run /api/admin/heartbeat-status for per-source detail.\n`;

    const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            // Idempotency-keyed on the window + tip id so a retried cron won't
            // double-send the same digest.
            "Idempotency-Key": `sec-alert:${since}:${rows.length ? rows[rows.length - 1].id : "stale"}`,
        },
        body: JSON.stringify({
            from: env.FROM_EMAIL,
            to: [env.ADMIN_ALERT_EMAIL],
            subject,
            text,
        }),
    });
    if (resp.status >= 400) {
        const body = (await resp.text()).slice(0, 500);
        throw new Error(`resend_${resp.status}: ${body}`);
    }

    // Advance cursor past the newest audit event we included, or to now if
    // the digest was purely a staleness alarm (so we don't re-send the same
    // stale-heartbeat digest every run).
    return {
        scanned_since: since,
        events: rows.length,
        stale_heartbeats: stale.length,
        cursor_ts: rows.length ? rows[rows.length - 1].ts : nowIso,
    };
}

const ENRICH_BATCH = 50;
const ENRICH_TIMEOUT_MS = 5000;

async function enrichShowLinks(env, nowIso) {
    const rows = (await env.DB.prepare(
        "SELECT id, url FROM show_links WHERE enriched_at IS NULL LIMIT ?1"
    ).bind(ENRICH_BATCH).all()).results || [];

    let enriched = 0, failed = 0;
    for (const row of rows) {
        let title = null, description = null;
        let fetchOk = false;
        try {
            if (!row.url || !row.url.startsWith("https://")) {
                failed++;
            } else {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), ENRICH_TIMEOUT_MS);
                const res = await fetch(row.url, {
                    signal: controller.signal,
                    headers: { "User-Agent": "SC-CPE-LinkEnricher/1.0" },
                    redirect: "follow",
                });
                clearTimeout(timer);
                const ct = res.headers.get("content-type") || "";
                if (res.ok && ct.includes("text/html")) {
                    const html = (await res.text()).slice(0, 200_000);
                    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
                    const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i);
                    title = (ogTitle?.[1] || pageTitle?.[1] || "").trim().slice(0, 500) || null;

                    const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
                        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
                    description = (ogDesc?.[1] || "").trim().slice(0, 1000) || null;
                    fetchOk = true;
                    enriched++;
                } else {
                    failed++;
                }
            }
        } catch {
            failed++;
        }
        await env.DB.prepare(
            "UPDATE show_links SET title = ?1, description = ?2, enriched_at = ?3 WHERE id = ?4"
        ).bind(title, description, nowIso, row.id).run();
    }
    return { candidates: rows.length, enriched, failed };
}

// Exported for tests.
export { staleHeartbeats };

// Purge throttles. Protect the worker from a spam-inflated R2 prefix that
// would otherwise loop forever and repeatedly time out the cron:
//   - PURGE_MAX_OBJECTS_PER_STREAM: hard cap per stream per invocation; on
//     hit, raw_r2_key stays set and the next run resumes (R2 delete is
//     idempotent, so partial progress is never lost).
//   - PURGE_WALL_BUDGET_MS: cross-stream wall-clock budget; ensures we
//     finish heartbeats + audits before the Worker subrequest limit.
//   - PURGE_MAX_STREAMS_PER_RUN: caps the streams pulled per invocation so
//     the LIST query itself can't blow up the budget on day 1 after a
//     backfill.
const PURGE_MAX_OBJECTS_PER_STREAM = 10_000;
const PURGE_WALL_BUDGET_MS = 20_000;
const PURGE_MAX_STREAMS_PER_RUN = 50;
const R2_DELETE_BATCH = 1000;

async function purgeOneStream(env, stream, budget) {
    const prefix = stream.raw_r2_key;
    let cursor = undefined;
    let deleted = 0;
    let hitCap = false;

    while (true) {
        if (budget.remainingMs() <= 0) { hitCap = true; break; }
        if (deleted >= PURGE_MAX_OBJECTS_PER_STREAM) { hitCap = true; break; }
        const pageLimit = Math.min(
            R2_DELETE_BATCH,
            PURGE_MAX_OBJECTS_PER_STREAM - deleted,
        );
        const listing = await env.RAW_CHAT.list({ prefix, cursor, limit: pageLimit });
        const keys = (listing.objects || []).map(o => o.key);
        if (keys.length === 0) break;
        await env.RAW_CHAT.delete(keys);
        deleted += keys.length;
        cursor = listing.truncated ? listing.cursor : undefined;
        if (!cursor) break;
    }
    return { deleted, hitCap };
}

export async function purgeExpired(env, now, opts = {}) {
    const wallBudgetMs = opts.wallBudgetMs ?? PURGE_WALL_BUDGET_MS;
    const maxStreams = opts.maxStreamsPerRun ?? PURGE_MAX_STREAMS_PER_RUN;
    const clock = opts.clock ?? (() => Date.now());
    const startMs = clock();
    const budget = { remainingMs: () => wallBudgetMs - (clock() - startMs) };

    const rs = await env.DB.prepare(`
        SELECT id, yt_video_id, scheduled_date, raw_r2_key, raw_purge_after
        FROM streams
        WHERE raw_r2_key IS NOT NULL
          AND raw_purge_after IS NOT NULL
          AND raw_purge_after < ?1
        ORDER BY raw_purge_after ASC
        LIMIT ?2
    `).bind(now, maxStreams).all();

    const streams = rs.results || [];
    let totalObjects = 0;
    let purgedStreams = 0;
    let partialStreams = 0;

    for (const s of streams) {
        if (budget.remainingMs() <= 0) break;
        const { deleted, hitCap } = await purgeOneStream(env, s, budget);

        if (!hitCap) {
            await env.DB.prepare(
                "UPDATE streams SET raw_r2_key = NULL, raw_purge_after = NULL WHERE id = ?1"
            ).bind(s.id).run();
            purgedStreams++;
        } else {
            partialStreams++;
        }

        await audit(env, "cron", null, "raw_chat_purged", "stream", s.id, null, {
            prefix: s.raw_r2_key, objects_deleted: deleted,
            purge_after: s.raw_purge_after, partial: hitCap,
        });

        totalObjects += deleted;
    }

    return {
        streams: purgedStreams, partial_streams: partialStreams,
        objects: totalObjects,
    };
}

async function heartbeat(env, source, status, detail) {
    const iso = new Date().toISOString();
    await env.DB.prepare(`
        INSERT INTO heartbeats (source, last_beat_at, last_status, detail_json)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(source) DO UPDATE SET
            last_beat_at = excluded.last_beat_at,
            last_status = excluded.last_status,
            detail_json = excluded.detail_json
    `).bind(source, iso, status, JSON.stringify(detail)).run();
}

// Canonical audit-row serialisation — MUST match pages/functions/_lib.js,
// workers/poller/src/index.js, and scripts/verify_audit_chain.py exactly.
function canonicalAuditRow(r) {
    return JSON.stringify([
        r.id, r.actor_type, r.actor_id ?? null, r.action,
        r.entity_type, r.entity_id,
        r.before_json ?? null, r.after_json ?? null,
        r.ip_hash ?? null, r.user_agent ?? null,
        r.ts, r.prev_hash ?? null,
    ]);
}

async function sha256Hex(s) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function audit(env, actorType, actorId, action, entityType, entityId, before, after) {
    const MAX_ATTEMPTS = 5;
    const row = {
        id: null,
        actor_type: actorType,
        actor_id: actorId ?? null,
        action,
        entity_type: entityType,
        entity_id: entityId,
        before_json: before == null ? null : JSON.stringify(before),
        after_json: after == null ? null : JSON.stringify(after),
        ip_hash: null,
        user_agent: null,
        ts: null,
        prev_hash: null,
    };

    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const tip = await env.DB.prepare(
            `SELECT id, actor_type, actor_id, action, entity_type, entity_id,
                    before_json, after_json, ip_hash, user_agent, ts, prev_hash
             FROM audit_log ORDER BY ts DESC, id DESC LIMIT 1`,
        ).first();

        row.prev_hash = tip ? await sha256Hex(canonicalAuditRow(tip)) : null;
        row.id = ulid();
        row.ts = new Date().toISOString();

        try {
            await env.DB.prepare(`
                INSERT INTO audit_log
                  (id, actor_type, actor_id, action, entity_type, entity_id,
                   before_json, after_json, ip_hash, user_agent, ts, prev_hash)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
            `).bind(
                row.id, row.actor_type, row.actor_id, row.action,
                row.entity_type, row.entity_id,
                row.before_json, row.after_json,
                row.ip_hash, row.user_agent, row.ts, row.prev_hash,
            ).run();
            return;
        } catch (err) {
            lastErr = err;
            if (!/UNIQUE/i.test(String(err && err.message || err))) throw err;
            await new Promise(r => setTimeout(r, 10 + Math.floor(Math.random() * 40)));
        }
    }
    throw new Error(`audit chain contention: ${MAX_ATTEMPTS} attempts failed: ${lastErr}`);
}

async function verifyBearer(request, env) {
    const expected = env.ADMIN_TOKEN;
    if (!expected) return false;
    const h = request.headers.get("Authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    const enc = new TextEncoder();
    const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey(
        "raw", keyMaterial, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const a = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(m[1])));
    const b = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(expected)));
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

async function discordPost(env, webhookUrl, content) {
    if (!webhookUrl) return;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content, username: "SC-CPE" }),
            signal: controller.signal,
        });
        clearTimeout(timer);
    } catch { /* fire-and-forget */ }
}

function ulid() {
    const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let ts = "", n = Date.now();
    for (let i = 9; i >= 0; i--, n = Math.floor(n / 32)) ts = A[n % 32] + ts;
    const rnd = crypto.getRandomValues(new Uint8Array(16));
    let r = "";
    for (let i = 0; i < 16; i++) r += A[rnd[i] % 32];
    return ts + r;
}
