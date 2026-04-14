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
    },
};

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
