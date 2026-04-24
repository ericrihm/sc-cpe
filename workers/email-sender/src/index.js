// email-sender: scheduled drainer for the email_outbox table.
//
// Reads rows in state='queued' (oldest first, capped per tick), POSTs each
// to Resend with the row's idempotency_key as Resend's Idempotency-Key
// header (so a retry after a timeout doesn't duplicate a send), and
// transitions queued -> sending -> sent | failed.
//
// Design notes:
// - `state='sending'` is a soft lock taken before the HTTP call. If the
//   Worker dies mid-flight the row stays 'sending' forever; a reconciler
//   in the 'too-old sending rows' branch rescues them. We accept that the
//   rescue path may double-send a row that Resend actually processed —
//   Resend's Idempotency-Key makes the second POST a no-op on their side.
// - Per-tick cap is intentional: we want a backlog to surface in the
//   sending queue (visible via wrangler d1) rather than hammer Resend.
// - Templates supported in MVP: 'monthly_cert', 'recover', 'register'.
//   payload_json carries the variables; subject is baked into the row.
// - The HTML/text bodies live in payload_json rather than being regenerated
//   here to avoid duplicating Jinja templates in JS. Producers (generate.py,
//   recover.js, register.js) are responsible for pre-rendering.

const RESEND_URL = "https://api.resend.com/emails";
const BATCH_SIZE = 25;          // rows to attempt per tick
const STUCK_SENDING_MIN = 5;    // rescue 'sending' rows older than this
const MAX_ATTEMPTS = 5;         // after which we mark 'failed' permanently

export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(tick(env));
    },
    // Optional manual poke for local testing: curl -X POST .../drain
    async fetch(request, env) {
        if (new URL(request.url).pathname !== "/drain") {
            return new Response("not found", { status: 404 });
        }
        if (request.method !== "POST") {
            return new Response("method not allowed", { status: 405 });
        }
        if (!await verifyBearer(request, env)) {
            return new Response("unauthorized", { status: 401 });
        }
        const summary = await tick(env);
        return new Response(JSON.stringify(summary), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    },
};

async function tick(env) {
    let summary;
    try {
        summary = await drain(env);
        await heartbeat(env, "ok", summary);
    } catch (err) {
        const msg = String(err?.message || err).slice(0, 500);
        await heartbeat(env, "error", { error: msg }).catch(() => {});
        throw err;
    }
    return summary;
}

async function heartbeat(env, status, detail) {
    if (!env.DB) return;
    const iso = new Date().toISOString();
    await env.DB.prepare(`
        INSERT INTO heartbeats (source, last_beat_at, last_status, detail_json)
        VALUES ('email_sender', ?1, ?2, ?3)
        ON CONFLICT(source) DO UPDATE SET
            last_beat_at = excluded.last_beat_at,
            last_status = excluded.last_status,
            detail_json = excluded.detail_json
    `).bind(iso, status, JSON.stringify(detail ?? {})).run();
}

async function drain(env) {
    if (!env.RESEND_API_KEY) {
        // Silent success hid a real outage: queued recover/register emails
        // sat forever while heartbeat reported "ok". Surface via an error
        // heartbeat so watchdog / stale-heartbeat digest catches it.
        throw new Error("RESEND_API_KEY_unset");
    }
    if (!env.FROM_EMAIL) {
        throw new Error("FROM_EMAIL_unset");
    }

    // Rescue stuck 'sending' rows: anything in that state > STUCK_SENDING_MIN
    // minutes is almost certainly from a dead Worker invocation. Flip back
    // to 'queued' so this tick picks them up (idempotency-keyed, safe).
    const stuckCutoff = new Date(Date.now() - STUCK_SENDING_MIN * 60 * 1000)
        .toISOString();
    await env.DB.prepare(`
        UPDATE email_outbox SET state = 'queued'
         WHERE state = 'sending' AND sent_at IS NOT NULL AND sent_at < ?1
    `).bind(stuckCutoff).run();

    const { results: rows = [] } = await env.DB.prepare(`
        SELECT id, user_id, template, to_email, subject, payload_json,
               idempotency_key, attempts
          FROM email_outbox
         WHERE state = 'queued'
         ORDER BY created_at ASC
         LIMIT ?1
    `).bind(BATCH_SIZE).all();

    let sent = 0, failed = 0;
    for (const row of rows) {
        // Claim the row. If UPDATE reports 0 changes another worker already
        // grabbed it (shouldn't happen given the scheduled cadence, but
        // belt-and-suspenders against concurrent fetch+cron).
        const claim = await env.DB.prepare(`
            UPDATE email_outbox SET state = 'sending', attempts = attempts + 1,
                   sent_at = ?2
             WHERE id = ?1 AND state = 'queued'
        `).bind(row.id, new Date().toISOString()).run();
        if (!claim.meta?.changes) continue;

        try {
            const resendId = await sendViaResend(env, row);
            await env.DB.prepare(`
                UPDATE email_outbox
                   SET state = 'sent', sent_at = ?1, resend_message_id = ?2,
                       last_error = NULL
                 WHERE id = ?3
            `).bind(new Date().toISOString(), resendId, row.id).run();
            sent++;
        } catch (err) {
            const msg = String(err?.message || err).slice(0, 500);
            const permanent = (row.attempts + 1) >= MAX_ATTEMPTS;
            await env.DB.prepare(`
                UPDATE email_outbox
                   SET state = ?1, last_error = ?2
                 WHERE id = ?3
            `).bind(permanent ? "failed" : "queued", msg, row.id).run();
            failed++;
            console.warn("email_send_failed", {
                id: row.id, template: row.template, attempt: row.attempts + 1,
                permanent, error: msg,
            });
        }
    }

    // Post-tick backlog numbers get baked into the heartbeat detail so
    // operators see "150 queued / oldest 4200s old" in the admin view and
    // `stale_heartbeats` digest. These are the earliest signal that Resend
    // rate-limits are biting or the sender is under-provisioned.
    let queueError = null;
    const [countResult, oldestResult] = await Promise.allSettled([
        env.DB.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE state = 'queued'").first(),
        env.DB.prepare("SELECT MIN(created_at) AS ts FROM email_outbox WHERE state = 'queued'").first(),
    ]);
    if (countResult.status === 'rejected') {
        queueError = countResult.reason?.message || 'queue_count_query_failed';
    }
    if (oldestResult.status === 'rejected' && !queueError) {
        queueError = oldestResult.reason?.message || 'queue_oldest_query_failed';
    }
    const queuedAfter = countResult.status === 'fulfilled' ? (countResult.value?.n ?? 0) : 0;
    const oldestRow = oldestResult.status === 'fulfilled' ? (oldestResult.value ?? {}) : {};
    const oldestAgeSec = oldestRow?.ts
        ? Math.max(0, Math.floor((Date.now() - new Date(oldestRow.ts).getTime()) / 1000))
        : null;

    const result = {
        attempted: rows.length, sent, failed,
        queued_after: queuedAfter,
        oldest_queued_age_seconds: oldestAgeSec,
    };
    if (queueError) result.queue_query_error = queueError;
    return result;
}

async function sendViaResend(env, row) {
    let payload;
    try {
        payload = JSON.parse(row.payload_json || "{}");
    } catch {
        throw new Error("payload_json_invalid");
    }
    const html = payload.html_body;
    const text = payload.text_body;
    if (!html && !text) throw new Error("payload_missing_body");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let resp;
    try {
        const resendBody = {
            from: env.FROM_EMAIL,
            to: [row.to_email],
            subject: row.subject,
            html,
            text,
        };
        if (payload.headers) resendBody.headers = payload.headers;
        resp = await fetch(RESEND_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${env.RESEND_API_KEY}`,
                "Content-Type": "application/json",
                "Idempotency-Key": row.idempotency_key,
            },
            body: JSON.stringify(resendBody),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }

    if (resp.status >= 400) {
        const body = (await resp.text()).slice(0, 500);
        throw new Error(`resend_${resp.status}: ${body}`);
    }
    const data = await resp.json();
    if (!data?.id) throw new Error("resend_response_missing_id");
    return data.id;
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
