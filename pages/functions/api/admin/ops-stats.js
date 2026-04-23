import { json, isAdmin } from "../../_lib.js";

// GET /api/admin/ops-stats
// Auth: Authorization: Bearer <ADMIN_TOKEN>
//
// Rollup counts for the admin dashboard. Cheap (COUNT queries, no joins on
// PII), safe to hit every time the dashboard loads. Numbers are for the
// last 24h and all-time where it's useful.
export async function onRequestGet({ request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }
    const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();

    const [
        usersTotal, usersActive, usersPending,
        attendance24h, certs24h, certsTotal,
        appealsOpen,
        outboxQueued, outboxFailed, outboxSent24h,
        outboxOldestQueued, outboxOldestFailed,
        certsPending, certsOldestPending,
        auditTip,
        activeNoChannel,
    ] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE state = 'active'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE state = 'pending_verification'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM attendance WHERE created_at > ?1").bind(since24h).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM certs WHERE created_at > ?1").bind(since24h).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM certs").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM appeals WHERE state = 'open'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE state = 'queued'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE state = 'failed'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE state = 'sent' AND sent_at > ?1").bind(since24h).first(),
        env.DB.prepare("SELECT MIN(created_at) AS ts FROM email_outbox WHERE state = 'queued'").first(),
        env.DB.prepare("SELECT MIN(created_at) AS ts FROM email_outbox WHERE state = 'failed'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM certs WHERE state = 'pending'").first(),
        env.DB.prepare("SELECT MIN(created_at) AS ts FROM certs WHERE state = 'pending'").first(),
        env.DB.prepare("SELECT id, ts, prev_hash FROM audit_log ORDER BY ts DESC, id DESC LIMIT 1").first(),
        env.DB.prepare(
            "SELECT COUNT(*) AS n FROM users WHERE state = 'active' AND yt_channel_id IS NULL AND deleted_at IS NULL"
        ).first(),
    ]);

    const nowMs = Date.now();
    const ageSecs = (iso) => iso ? Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000)) : null;

    const fixtureStreams = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM streams WHERE id LIKE '01KTEST%' OR yt_video_id LIKE 'TEST%'",
    ).first();
    const fixtureAttendance = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM attendance WHERE first_msg_sha256 = 'deadbeef' OR first_msg_id LIKE 'TESTMSG%'",
    ).first();
    const fixtureUsers = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND (email LIKE '%@example.com' OR email LIKE '%@example.org' OR email LIKE '%@test.invalid')",
    ).first();

    const payload = {
        ok: true,
        now: new Date().toISOString(),
        since_24h: since24h,
        users: {
            total: usersTotal?.n ?? 0,
            active: usersActive?.n ?? 0,
            pending: usersPending?.n ?? 0,
            active_no_channel: activeNoChannel?.n ?? 0,
        },
        last_24h: {
            attendance: attendance24h?.n ?? 0,
            certs_issued: certs24h?.n ?? 0,
        },
        certs_total: certsTotal?.n ?? 0,
        appeals_open: appealsOpen?.n ?? 0,
        email_outbox: {
            queued: outboxQueued?.n ?? 0,
            failed: outboxFailed?.n ?? 0,
            sent_24h: outboxSent24h?.n ?? 0,
            // Oldest-age surfaces backlog aging before count alone would:
            // 50 queued for 30 seconds is fine, 3 queued for an hour is a
            // silent outage in email-sender. Admin dashboard flags this.
            oldest_queued_age_seconds: ageSecs(outboxOldestQueued?.ts),
            oldest_failed_age_seconds: ageSecs(outboxOldestFailed?.ts),
        },
        certs: {
            pending: certsPending?.n ?? 0,
            oldest_pending_age_seconds: ageSecs(certsOldestPending?.ts),
        },
        audit_tip: auditTip
            ? { id: auditTip.id, ts: auditTip.ts, prev_hash: auditTip.prev_hash }
            : null,
        fixture_pollution: {
            streams: fixtureStreams?.n ?? 0,
            attendance: fixtureAttendance?.n ?? 0,
            users: fixtureUsers?.n ?? 0,
        },
    };
    payload.warnings = computeWarnings(payload);
    return json(payload);
}

// Launch-day budget + health warnings. Pure function so the admin
// dashboard and any future external monitor can render from the same
// source. Each warning is {level: "warn"|"critical", code, detail}.
//
// Thresholds are tuned for the free-tier infrastructure (Resend 3k/day,
// Cloudflare D1 free limits). Update the constants if we upgrade a tier.
export function computeWarnings(s) {
    const w = [];
    const push = (level, code, detail) => w.push({ level, code, detail });

    // Resend free tier: 3000 emails/day. Warn at 80%, critical at 95%.
    const RESEND_DAILY_QUOTA = 3000;
    const sent = s.email_outbox.sent_24h;
    if (sent >= RESEND_DAILY_QUOTA * 0.95) {
        push("critical", "resend_quota_95pct",
            `${sent}/${RESEND_DAILY_QUOTA} Resend emails in last 24h — approaching daily quota`);
    } else if (sent >= RESEND_DAILY_QUOTA * 0.8) {
        push("warn", "resend_quota_80pct",
            `${sent}/${RESEND_DAILY_QUOTA} Resend emails in last 24h`);
    }

    // Queue age > 10min = email-sender looks stalled (runs every 2min).
    const qAge = s.email_outbox.oldest_queued_age_seconds;
    if (qAge != null && qAge > 1800) {
        push("critical", "email_queue_stalled",
            `Oldest queued email is ${Math.floor(qAge / 60)} min old — email-sender may be down`);
    } else if (qAge != null && qAge > 600) {
        push("warn", "email_queue_aging",
            `Oldest queued email is ${Math.floor(qAge / 60)} min old`);
    }

    // Queue depth warnings (sender drains ~750/hour — burst above this floods).
    if (s.email_outbox.queued > 500) {
        push("critical", "email_queue_deep",
            `${s.email_outbox.queued} queued — exceeds single-hour drain capacity`);
    } else if (s.email_outbox.queued > 100) {
        push("warn", "email_queue_elevated", `${s.email_outbox.queued} queued`);
    }

    // Any permanently-failed email is worth noticing.
    if (s.email_outbox.failed > 0) {
        push("warn", "email_failures",
            `${s.email_outbox.failed} email(s) in 'failed' state — non-transient delivery errors`);
    }

    // Pending certs: cron runs every 2h. > 4h old = cron stalled.
    const cpAge = s.certs.oldest_pending_age_seconds;
    if (cpAge != null && cpAge > 12 * 3600) {
        push("critical", "certs_pending_stalled",
            `Oldest pending cert is ${Math.floor(cpAge / 3600)}h old — cert-sign-pending may be down`);
    } else if (cpAge != null && cpAge > 4 * 3600) {
        push("warn", "certs_pending_aging",
            `Oldest pending cert is ${Math.floor(cpAge / 3600)}h old`);
    }

    // Signup abuse signal: high pending ratio (signups without verifications).
    // Only fires past a minimum volume to avoid noisy early-stage warnings.
    if (s.users.pending > 100 && s.users.active > 0 && s.users.pending > 5 * s.users.active) {
        push("warn", "signup_abuse_pattern",
            `${s.users.pending} pending vs ${s.users.active} active — unusually high unverified signup rate`);
    }

    // Active users without a YouTube channel can't complete verification
    // via the normal chat-code flow. Usually means admin-granted attendance
    // or a resend-code regression — either way, worth investigating.
    if (s.users.active_no_channel > 0) {
        push("warn", "active_no_channel",
            `${s.users.active_no_channel} active user(s) without YouTube channel linked — may need resend-code`);
    }

    // Open appeals: anything open > 0 is worth an admin eyeball.
    if (s.appeals_open > 0) {
        push("warn", "appeals_open",
            `${s.appeals_open} open appeal(s) awaiting admin review`);
    }

    // Fixture pollution in prod — test data leaked into production DB.
    const fp = s.fixture_pollution;
    if (fp.streams + fp.attendance + fp.users > 0) {
        push("warn", "fixture_pollution",
            `Test fixtures detected in DB: ${fp.streams} streams, ${fp.attendance} attendance, ${fp.users} users`);
    }

    return w;
}
