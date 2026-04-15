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
        outboxQueued, outboxFailed,
        auditTip,
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
        env.DB.prepare("SELECT id, ts, prev_hash FROM audit_log ORDER BY ts DESC, id DESC LIMIT 1").first(),
    ]);

    return json({
        ok: true,
        now: new Date().toISOString(),
        since_24h: since24h,
        users: {
            total: usersTotal?.n ?? 0,
            active: usersActive?.n ?? 0,
            pending: usersPending?.n ?? 0,
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
        },
        audit_tip: auditTip
            ? { id: auditTip.id, ts: auditTip.ts, prev_hash: auditTip.prev_hash }
            : null,
    });
}
