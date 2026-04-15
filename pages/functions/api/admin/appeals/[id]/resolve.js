import { ulid, json, audit, clientIp, ipHash, isAdmin, now, getCpePerDay } from "../../../../_lib.js";

// POST /api/admin/appeals/{id}/resolve
// Auth: Authorization: Bearer <ADMIN_TOKEN>
// Body: {
//   "decision": "grant" | "deny" | "cancel",
//   "notes": "free-text reasoning shown in audit log",
//   "resolver": "short admin handle",           // required; goes into resolved_by
//   "rule_version": 1                            // required when decision=grant
// }
//
// On "grant" we insert an attendance row with source='appeal_granted' against
// the appeal's claimed_stream_id. Idempotent: if a row already exists for
// (user_id, stream_id) we leave it alone and still flip the appeal state so
// the queue stays drainable.
//
// "deny" and "cancel" only mutate the appeal row.
//
// Rejects decisions on already-resolved appeals (state != 'open') — re-opens
// require a database-level intervention by design; we don't want an admin
// accidentally flipping a granted appeal without a paper trail.
export async function onRequestPost({ params, request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }

    const appealId = params.id;
    if (!appealId || appealId.length < 10) {
        return json({ error: "invalid_appeal_id" }, 400);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }

    const decision = body?.decision;
    const notes = (body?.notes || "").trim();
    const resolver = (body?.resolver || "").trim();
    if (!["grant", "deny", "cancel"].includes(decision)) {
        return json({ error: "invalid_decision" }, 400);
    }
    if (!resolver || resolver.length > 80) {
        return json({ error: "resolver_required" }, 400);
    }
    if (notes.length > 2000) {
        return json({ error: "notes_too_long" }, 400);
    }

    const appeal = await env.DB.prepare(`
        SELECT id, user_id, claimed_stream_id, state
          FROM appeals WHERE id = ?1
    `).bind(appealId).first();
    if (!appeal) return json({ error: "appeal_not_found" }, 404);
    if (appeal.state !== "open") {
        return json({ error: "appeal_not_open", state: appeal.state }, 409);
    }

    const ts = now();
    const newState = decision === "grant" ? "granted"
        : decision === "deny" ? "denied" : "cancelled";
    let attendanceInserted = false;

    if (decision === "grant") {
        if (!appeal.claimed_stream_id) {
            return json({ error: "appeal_missing_stream_id" }, 422);
        }
        const ruleVersion = parseInt(body?.rule_version, 10);
        if (!Number.isFinite(ruleVersion) || ruleVersion < 1) {
            return json({ error: "rule_version_required" }, 400);
        }

        const existing = await env.DB.prepare(`
            SELECT 1 FROM attendance WHERE user_id = ?1 AND stream_id = ?2
        `).bind(appeal.user_id, appeal.claimed_stream_id).first();

        if (!existing) {
            // source='appeal_granted' differentiates from poller rows so an
            // integrity audit can account for every manual credit. earned_cpe
            // pulls from the same kv-driven helper as the poller so an admin
            // grant always matches the credit a poller match would have given
            // for the active rule version.
            const cpe = await getCpePerDay(env, ruleVersion);
            await env.DB.prepare(`
                INSERT INTO attendance
                  (user_id, stream_id, earned_cpe, first_msg_id, first_msg_at,
                   first_msg_sha256, first_msg_len, rule_version, source, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, '', 0, ?6, 'appeal_granted', ?7)
            `).bind(
                appeal.user_id, appeal.claimed_stream_id, cpe,
                `appeal:${appeal.id}`, ts, ruleVersion, ts,
            ).run();
            attendanceInserted = true;
        }
    }

    await env.DB.prepare(`
        UPDATE appeals
           SET state = ?1, resolution_notes = ?2, resolved_by = ?3, resolved_at = ?4
         WHERE id = ?5 AND state = 'open'
    `).bind(newState, notes || null, resolver, ts, appeal.id).run();

    await audit(
        env, "admin", resolver, `appeal_${newState}`, "appeal", appeal.id,
        { state: "open" },
        {
            state: newState,
            resolver,
            attendance_inserted: attendanceInserted,
            stream_id: appeal.claimed_stream_id,
        },
        { ip_hash: await ipHash(clientIp(request)) },
    );

    return json({
        ok: true,
        appeal_id: appeal.id,
        state: newState,
        attendance_inserted: attendanceInserted,
        resolved_at: ts,
    });
}
