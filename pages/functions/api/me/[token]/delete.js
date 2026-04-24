import { json, audit, clientIp, ipHash, now, isSameOrigin, rateLimit, isValidToken, queueEmail, escapeHtml, emailShell, emailDivider } from "../../../_lib.js";

// POST /api/me/{token}/delete
// Body: { "confirm": "DELETE" }  (explicit confirmation, prevents XSRF-ish
//                                  accidental deletion via link preview)
//
// Privacy carve-out — read before editing:
//
// GDPR "right to erasure" (Art. 17) allows retention for "compliance with
// a legal obligation" and "establishment, exercise or defence of legal
// claims" (Art. 17(3)(b), (e)). Every cert we issue is an evidentiary
// artefact that may be checked by third parties (employers, ISC2/ISACA
// auditors) years after issuance. A naïve cascade-delete would break
// that verifiability for every cert the user holds.
//
// What we delete here:
//   - users.email         → scrubbed to "deleted-<userid>@invalid"
//   - users.legal_name    → scrubbed to "Deleted User"
//   - users.yt_channel_id → NULL
//   - users.yt_display_name_seen → NULL
//   - users.verification_code → NULL
//   - users.dashboard_token → rotated to a random value (locks the user out)
//   - users.deleted_at    → now
//   - users.state         → 'deleted'
//
// What we retain:
//   - certs rows (public_token, recipient_name_snapshot, hashes). These
//     are the evidentiary record; without them the cert becomes
//     unverifiable and we lose defensibility.
//   - audit_log rows (hash-chained, must not be mutated).
//   - attendance rows (reference user_id by FK but we leave the row).
//
// Effects downstream:
//   - /api/me/{old_token} → 404 (dashboard_token rotated)
//   - /api/verify/{public_token} → still works, still shows the
//     recipient_name_snapshot that was on the cert at issuance. That
//     name does NOT update to "Deleted User" — it is a snapshot from
//     months or years before the deletion request.
//
// The privacy policy documents this carve-out; it must stay in sync.
export async function onRequestPost({ params, request, env }) {
    const token = params.token;
    if (!isValidToken(token)) return json({ error: "invalid_token" }, 400);

    // CSRF gate: dashboard_token sits in URLs and can leak via Referer or
    // shared bookmarks. Without an Origin check, a third-party page that
    // knows the victim's token can POST here from a hidden iframe and
    // tombstone the account.
    if (!isSameOrigin(request, env)) {
        return json({ error: "forbidden_origin" }, 403);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    if (body?.confirm !== "DELETE") {
        return json({ error: "confirmation_required", detail: 'Body must be {"confirm":"DELETE"}' }, 400);
    }

    const ipH = await ipHash(clientIp(request));
    const rl = await rateLimit(env, `delete:${ipH}`, 5);
    if (!rl.ok) return json(rl.body, rl.status, rl.headers);

    const user = await env.DB.prepare(`
        SELECT id, email, legal_name, state, deleted_at
          FROM users WHERE dashboard_token = ?1
    `).bind(token).first();

    if (!user) return json({ error: "not_found" }, 404);
    if (user.deleted_at) {
        return json({ ok: true, already_deleted: true, deleted_at: user.deleted_at });
    }

    const ts = now();
    const scrubbedEmail = `deleted-${user.id}@invalid`;
    // Rotate dashboard_token to invalidate any stored link/bookmark. The
    // unique index is on dashboard_token, so just generate a random 64-hex.
    const rotated = [...crypto.getRandomValues(new Uint8Array(32))]
        .map(b => b.toString(16).padStart(2, "0")).join("");

    const siteBase = new URL(request.url).origin;
    const delSubject = "Your SC-CPE account has been deleted";
    const delText = `Hi ${user.legal_name},\n\nYour SC-CPE account has been deleted as requested. Any issued certificates remain verifiable per our retention policy (GDPR Art. 17(3)(e)).\n\nIf you did not request this, please contact us immediately.\n\n— SC-CPE`;
    const delHtml = emailShell({
        title: "Account Deleted",
        preheader: "Your SC-CPE account has been deleted",
        bodyHtml: `<p>Hi ${escapeHtml(user.legal_name)},</p>
<p>Your SC-CPE account has been deleted as requested.</p>
<p>Any issued certificates remain independently verifiable per our retention policy (GDPR Art.&nbsp;17(3)(e)). The recipient name on each certificate is frozen at the time of issuance and will not change.</p>
${emailDivider()}
<p style="color:#888;font-size:13px;">If you did not request this deletion, please contact us immediately.</p>`,
        siteBase,
    });
    await queueEmail(env, {
        userId: user.id,
        template: "account_deleted",
        to: user.email,
        subject: delSubject,
        html: delHtml,
        text: delText,
        idempotencyKey: `account_deleted:${user.id}:${ts}`,
    });

    await env.DB.prepare(`
        UPDATE users
           SET email                 = ?1,
               legal_name            = 'Deleted User',
               yt_channel_id         = NULL,
               yt_display_name_seen  = NULL,
               verification_code     = NULL,
               code_expires_at       = NULL,
               dashboard_token       = ?2,
               state                 = 'deleted',
               deleted_at            = ?3
         WHERE id = ?4
    `).bind(scrubbedEmail, rotated, ts, user.id).run();

    await audit(
        env,
        "user",
        user.id,
        "user_deleted",
        "user",
        user.id,
        { state: user.state },
        {
            state: "deleted",
            deleted_at: ts,
            // Explicit record that certs were retained under the Art. 17(3)(e)
            // carve-out. Auditable if the user later disputes.
            certs_retained_reason: "gdpr_17_3_e_evidentiary",
        },
        { ip_hash: await ipHash(clientIp(request)) },
    );

    return json({
        ok: true,
        deleted_at: ts,
        certs_retained: true,
        note: "Per Art. 17(3)(e) GDPR, issued certificates are retained as evidentiary artefacts. The recipient_name_snapshot on each cert is fixed at issuance and does not update.",
    });
}
