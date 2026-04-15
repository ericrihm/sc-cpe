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
        ctx.waitUntil(drain(env));
    },
    // Optional manual poke for local testing: curl -X POST .../drain
    async fetch(request, env) {
        if (new URL(request.url).pathname !== "/drain") {
            return new Response("not found", { status: 404 });
        }
        if (request.method !== "POST") {
            return new Response("method not allowed", { status: 405 });
        }
        const auth = request.headers.get("Authorization") || "";
        if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) {
            return new Response("unauthorized", { status: 401 });
        }
        const summary = await drain(env);
        return new Response(JSON.stringify(summary), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    },
};

async function drain(env) {
    if (!env.RESEND_API_KEY) {
        console.warn("RESEND_API_KEY unset — drainer no-op");
        return { attempted: 0, sent: 0, failed: 0, skipped: "no_resend_key" };
    }

    // Rescue stuck 'sending' rows: anything in that state > STUCK_SENDING_MIN
    // minutes is almost certainly from a dead Worker invocation. Flip back
    // to 'queued' so this tick picks them up (idempotency-keyed, safe).
    const stuckCutoff = new Date(Date.now() - STUCK_SENDING_MIN * 60 * 1000)
        .toISOString();
    await env.DB.prepare(`
        UPDATE email_outbox SET state = 'queued'
         WHERE state = 'sending' AND created_at < ?1
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
            UPDATE email_outbox SET state = 'sending', attempts = attempts + 1
             WHERE id = ?1 AND state = 'queued'
        `).bind(row.id).run();
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

    return { attempted: rows.length, sent, failed };
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

    const resp = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": row.idempotency_key,
        },
        body: JSON.stringify({
            from: env.FROM_EMAIL,
            to: [row.to_email],
            subject: row.subject,
            html,
            text,
        }),
    });

    if (resp.status >= 400) {
        const body = (await resp.text()).slice(0, 500);
        throw new Error(`resend_${resp.status}: ${body}`);
    }
    const data = await resp.json();
    if (!data?.id) throw new Error("resend_response_missing_id");
    return data.id;
}
