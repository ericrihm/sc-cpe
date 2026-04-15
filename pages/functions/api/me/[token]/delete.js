import { json, audit, clientIp, ipHash, now } from "../../../_lib.js";

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
    if (!token || token.length < 32) {
        return json({ error: "invalid_token" }, 400);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    if (body?.confirm !== "DELETE") {
        return json({ error: "confirmation_required", detail: 'Body must be {"confirm":"DELETE"}' }, 400);
    }

    const user = await env.DB.prepare(`
        SELECT id, email, state, deleted_at
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
