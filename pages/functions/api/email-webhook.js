import { json, audit, now } from "../_lib.js";

// Svix webhook verification. The signed message is
// `svix-id + "." + svix-timestamp + "." + raw-body-string`. The shared
// secret is base64-encoded, optionally prefixed with `whsec_`.
// Constant-time comparison guards against timing oracle on the HMAC.
async function verifyWebhook(env, request, rawBody) {
    if (!env.RESEND_WEBHOOK_SECRET) return true; // open during initial setup

    const svixId = request.headers.get("svix-id") || "";
    const svixTs = request.headers.get("svix-timestamp") || "";
    const svixSig = request.headers.get("svix-signature") || "";
    if (!svixId || !svixTs || !svixSig) return false;

    // Reject stale timestamps (>5 min) to prevent replay attacks.
    const ts = parseInt(svixTs, 10);
    if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return false;

    const toSign = `${svixId}.${svixTs}.${rawBody}`;
    const b64 = env.RESEND_WEBHOOK_SECRET.startsWith("whsec_")
        ? env.RESEND_WEBHOOK_SECRET.slice(6)
        : env.RESEND_WEBHOOK_SECRET;
    const keyBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
        "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sigBytes = await crypto.subtle.sign(
        "HMAC", key, new TextEncoder().encode(toSign),
    );
    const computed = "v1," + btoa(String.fromCharCode(...new Uint8Array(sigBytes)));

    // Svix may send up to five space-separated `v1,<b64>` values.
    const enc = new TextEncoder();
    const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
    const hmacKey = await crypto.subtle.importKey(
        "raw", keyMaterial, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const cb = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, enc.encode(computed)));

    for (const candidate of svixSig.split(" ")) {
        const t = candidate.trim();
        if (!t) continue;
        const pb = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, enc.encode(t)));
        let diff = 0;
        for (let i = 0; i < cb.length; i++) diff |= cb[i] ^ pb[i];
        if (diff === 0) return true;
    }
    return false;
}

export async function onRequestPost({ request, env }) {
    const rawBody = await request.text();

    if (!await verifyWebhook(env, request, rawBody)) {
        return json({ error: "invalid_signature" }, 401);
    }

    let event;
    try { event = JSON.parse(rawBody); }
    catch { return json({ error: "invalid_json" }, 400); }

    const type = event?.type || "";

    // Silently ack delivery/engagement events and any unknown type so Resend
    // doesn't retry indefinitely.
    if (type !== "email.bounced" && type !== "email.complained") {
        return json({ ok: true });
    }

    const emailId = event?.data?.email_id || "";
    const to = (event?.data?.to?.[0] || event?.data?.email_address || "").toLowerCase().trim();

    if (!to) return json({ error: "missing_email" }, 400);

    const action = type === "email.bounced" ? "email_bounced" : "email_complained";
    const reason = type === "email.bounced" ? "hard_bounce" : "spam_complaint";
    const nowIso = now();

    // Mark matching outbox row as bounced so operators can see it.
    if (emailId) {
        await env.DB.prepare(`
            UPDATE email_outbox SET state = 'bounced', last_error = ?1
             WHERE resend_message_id = ?2 AND state NOT IN ('bounced','failed')
        `).bind(reason, emailId).run();
    }

    // Upsert into suppression list. ON CONFLICT DO NOTHING is intentional:
    // once an address is suppressed the original reason is the important one.
    await env.DB.prepare(`
        INSERT INTO email_suppression (email, reason, event_id, created_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(email) DO NOTHING
    `).bind(to, reason, emailId || null, nowIso).run();

    await audit(env, "system", null, action, "email", to,
        null, { reason, event_id: emailId || null });

    return json({ ok: true });
}
