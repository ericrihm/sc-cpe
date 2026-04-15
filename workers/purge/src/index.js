// Daily raw-chat purge. Deletes R2 objects for streams past their raw_purge_after
// timestamp. Writes audit_log entry per purged stream and a heartbeat.

export default {
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
    },
};

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
    if (!env.DASHBOARD_BASE_URL && !env.VERIFY_BASE_URL) {
        return { skipped: "missing_base_url" };
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
    const verifyBase = (env.VERIFY_BASE_URL || "").replace(/\/$/, "");
    const dashBase = (env.DASHBOARD_BASE_URL || "").replace(/\/$/, "");

    for (const r of rows) {
        try {
            const prefs = JSON.parse(r.email_prefs || "{}") || {};
            if (prefs.monthly_cert === false) { skipped++; continue; }

            const verifyUrl = `${verifyBase}/${r.public_token}`;
            const dashUrl = dashBase ? `${dashBase}/${r.dashboard_token}` : "";
            const subject = `Your ${period} CPE cert — a quick check?`;
            const text =
                `Hi ${r.legal_name || "there"},\n\n` +
                `Your ${period} Simply Cyber DTB CPE certificate was issued ` +
                `last week. Please take a moment to open it and confirm the ` +
                `details are correct:\n\n` +
                `  ${verifyUrl}\n\n` +
                (dashUrl ? `Dashboard: ${dashUrl}\n\n` : "") +
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
                (dashUrl ? `<p>Dashboard: <a href="${dashUrl}">${dashUrl}</a></p>` : "") +
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
            "Idempotency-Key": `sec-alert:${since}:${rows[rows.length - 1].id}`,
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

    // Advance cursor only after a successful send so a failed email gets
    // retried on the next run instead of being silently lost. If there were
    // no audit events (digest was purely a staleness alarm), keep the cursor
    // where it was so the next run still scans from the same point.
    return {
        scanned_since: since,
        events: rows.length,
        stale_heartbeats: stale.length,
        cursor_ts: rows.length ? rows[rows.length - 1].ts : since,
    };
}

// Exported for tests.
export { staleHeartbeats };

async function purgeExpired(env, now) {
    const rs = await env.DB.prepare(`
        SELECT id, yt_video_id, scheduled_date, raw_r2_key, raw_purge_after
        FROM streams
        WHERE raw_r2_key IS NOT NULL
          AND raw_purge_after IS NOT NULL
          AND raw_purge_after < ?1
    `).bind(now).all();

    const streams = rs.results || [];
    let totalObjects = 0;
    let purgedStreams = 0;

    for (const s of streams) {
        const prefix = s.raw_r2_key;
        let cursor = undefined;
        let count = 0;
        do {
            const listing = await env.RAW_CHAT.list({ prefix, cursor, limit: 1000 });
            for (const obj of listing.objects) {
                await env.RAW_CHAT.delete(obj.key);
                count++;
            }
            cursor = listing.truncated ? listing.cursor : undefined;
        } while (cursor);

        await env.DB.prepare(
            "UPDATE streams SET raw_r2_key = NULL, raw_purge_after = NULL WHERE id = ?1"
        ).bind(s.id).run();

        await audit(env, "cron", null, "raw_chat_purged", "stream", s.id, null, {
            prefix, objects_deleted: count, purge_after: s.raw_purge_after,
        });

        totalObjects += count;
        purgedStreams++;
    }

    return { streams: purgedStreams, objects: totalObjects };
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

function ulid() {
    const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let ts = "", n = Date.now();
    for (let i = 9; i >= 0; i--, n = Math.floor(n / 32)) ts = A[n % 32] + ts;
    const rnd = crypto.getRandomValues(new Uint8Array(16));
    let r = "";
    for (let i = 0; i < 16; i++) r += A[rnd[i] % 32];
    return ts + r;
}
