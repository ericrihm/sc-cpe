// SC-CPE poller. Runs every minute via cron; self-gates to ET weekday window.
// Each cron firing fetches one page of liveChatMessages.list, processes it,
// and saves nextPageToken to D1 kv for the next firing to continue from.

const YT = "https://www.googleapis.com/youtube/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Matches both old SC-CPE-XXXXXXXX and new SC-CPE{XXXX-XXXX} formats.
const CODE_RE = /SC-CPE[-{]([0-9A-HJKMNP-TV-Z]{4})-?([0-9A-HJKMNP-TV-Z]{4})\}?/i;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken(env) {
    if (!env.YOUTUBE_OAUTH_CLIENT_ID || !env.YOUTUBE_OAUTH_REFRESH_TOKEN) return null;
    if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: env.YOUTUBE_OAUTH_CLIENT_ID,
            client_secret: env.YOUTUBE_OAUTH_CLIENT_SECRET,
            refresh_token: env.YOUTUBE_OAUTH_REFRESH_TOKEN,
            grant_type: "refresh_token",
        }),
    });
    const data = await res.json();
    if (data.error) {
        console.error(`[poller] OAuth refresh failed: ${data.error} — ${data.error_description}`);
        cachedToken = null;
        cachedTokenExpiry = 0;
        return null;
    }

    cachedToken = data.access_token;
    cachedTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return cachedToken;
}
function extractCode(match) { return (match[1] + match[2]).toUpperCase(); }

// Exported for tests: given a YouTube liveChatMessages batch, return the set
// of codes that appeared from two or more distinct channels. Pure function,
// no I/O — so the race-detection invariant can be asserted without a runtime.
export function detectContestedCodes(items) {
    const firstChannel = new Map();
    const contested = new Set();
    for (const m of items) {
        const text = m?.snippet?.displayMessage || "";
        const match = CODE_RE.exec(text);
        if (!match) continue;
        const code = extractCode(match);
        const channelId = m?.authorDetails?.channelId;
        if (!channelId) continue;
        const seen = firstChannel.get(code);
        if (seen && seen !== channelId) contested.add(code);
        else if (!seen) firstChannel.set(code, channelId);
    }
    return contested;
}

export default {
    async scheduled(event, env, ctx) {
        const now = new Date();
        if (!inPollWindow(now, env).ok) return;
        try {
            const meta = await tick(env, now);
            await heartbeat(env, "poller", "ok", {
                at: now.toISOString(),
                auth_method: meta?.auth_method ?? "none",
            });
        } catch (err) {
            await heartbeat(env, "poller", "error", {
                at: now.toISOString(),
                msg: String(err && err.message || err),
            });
            throw err;
        }
    },
};

function inPollWindow(now, env) {
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: env.POLL_WINDOW_TZ,
        hour12: false,
        weekday: "short",
        hour: "2-digit",
    });
    const p = fmt.formatToParts(now).reduce((o, x) => (o[x.type] = x.value, o), {});
    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = dowMap[p.weekday];
    const hour = parseInt(p.hour, 10);
    const days = env.POLL_WINDOW_DAYS.split(",").map(Number);
    return {
        ok: days.includes(dow)
            && hour >= parseInt(env.POLL_WINDOW_START_HOUR, 10)
            && hour < parseInt(env.POLL_WINDOW_END_HOUR, 10),
    };
}

async function tick(env, now) {
    const meta = { auth_method: "none" };
    const breaker = await env.DB.prepare("SELECT v FROM kv WHERE k = 'circuit.youtube_quota'").first();
    if (breaker) {
        const state = JSON.parse(breaker.v);
        if (new Date(state.resume_after) > now) return meta;
    }

    const today = isoDate(now);
    const session = await loadSession(env, today);

    if (session?.stream_id) {
        if (session.state === "complete" || session.state === "flagged") return meta;
        if (session.next_poll_at && new Date(session.next_poll_at) > now) return meta;
        meta.auth_method = await pollOnePage(env, session, now);
        return meta;
    }

    const discovered = await discoverLiveStream(env);
    if (discovered) meta.auth_method = discovered._auth_method;
    if (!discovered) {
        await kvSet(env, `session.${today}`, { state: "searching", last_check: now.toISOString() });
        return meta;
    }

    const streamRowId = await upsertStream(env, discovered, now);
    const newSession = {
        date: today,
        state: "live",
        stream_id: streamRowId,
        video_id: discovered.videoId,
        live_chat_id: discovered.liveChatId,
        page_token: null,
        next_poll_at: null,
        actual_start_at: discovered.actualStartTime,
    };
    await kvSet(env, `session.${today}`, newSession);
    await audit(env, "poller", null, "stream_discovered", "stream", streamRowId, null, discovered);
    meta.auth_method = await pollOnePage(env, newSession, now);
    return meta;
}

async function discoverLiveStream(env) {
    let token;
    try { token = await getAccessToken(env); }
    catch (e) { console.error(`[poller] OAuth error in discover: ${e.message}`); token = null; }
    const channel = env.SC_CHANNEL_ID;
    const authParam = token ? "" : `&key=${env.YOUTUBE_API_KEY}`;
    const search = await ytGet(`${YT}/search?part=id&channelId=${channel}&eventType=live&type=video&maxResults=2${authParam}`, token);
    const items = search.items || [];
    if (items.length === 0) return null;
    if (items.length > 1) {
        console.warn(`[poller] ${items.length} live items; refusing to guess`);
        return null;
    }
    const videoId = items[0].id.videoId;

    const videos = await ytGet(`${YT}/videos?part=liveStreamingDetails,snippet&id=${videoId}${authParam}`, token);
    const v = (videos.items || [])[0];
    if (!v) return null;
    if (v.snippet.liveBroadcastContent !== "live") return null;
    const lsd = v.liveStreamingDetails || {};
    if (!lsd.activeLiveChatId || !lsd.actualStartTime) return null;

    return {
        videoId,
        title: v.snippet.title,
        liveChatId: lsd.activeLiveChatId,
        actualStartTime: lsd.actualStartTime,
        _auth_method: token ? "oauth" : "api_key",
    };
}

const FINALIZE_ERROR_STRIKES = 3;
const FINALIZE_ELAPSED_MIN = 90;

async function pollOnePage(env, session, now) {
    let token;
    try { token = await getAccessToken(env); }
    catch (e) { console.error(`[poller] OAuth error in poll: ${e.message}`); token = null; }
    const authMethod = token ? "oauth" : "api_key";
    const authParam = token ? "" : `&key=${env.YOUTUBE_API_KEY}`;
    const params = new URLSearchParams({
        liveChatId: session.live_chat_id,
        part: "snippet,authorDetails",
        maxResults: "2000",
    });
    if (!token) params.set("key", env.YOUTUBE_API_KEY);
    if (session.page_token) params.set("pageToken", session.page_token);

    let data;
    try {
        data = await ytGet(`${YT}/liveChatMessages?${params}`, token);
    } catch (err) {
        const msg = String(err && err.message || err);
        const is403or404 = msg.includes(" 403") || msg.includes(" 404");
        if (!is403or404) throw err;

        // Quota exhaustion must never finalize — legit live stream would be
        // dropped mid-flight. Heartbeat carries the signal via the scheduled()
        // error path; rethrow so watchdog sees it.
        if (/quotaExceeded/i.test(msg)) {
            await kvSet(env, 'circuit.youtube_quota', {
                tripped_at: now.toISOString(),
                resume_after: new Date(now.getTime() + 15 * 60_000).toISOString(),
            });
            throw err;
        }

        const strikes = (session.consecutive_fetch_errors || 0) + 1;
        const elapsedMin = (now.getTime() - new Date(session.actual_start_at).getTime()) / 60_000;

        let confirmedEnded = false;
        try {
            const v = await ytGet(`${YT}/videos?part=liveStreamingDetails&id=${session.video_id}${authParam}`, token);
            const end = v?.items?.[0]?.liveStreamingDetails?.actualEndTime;
            if (end) confirmedEnded = true;
        } catch { /* treat as inconclusive */ }

        if (confirmedEnded || strikes >= FINALIZE_ERROR_STRIKES || elapsedMin >= FINALIZE_ELAPSED_MIN) {
            const reason = confirmedEnded
                ? "actual_end_time_confirmed"
                : strikes >= FINALIZE_ERROR_STRIKES
                    ? "fetch_errors_exhausted"
                    : "max_elapsed_exceeded";
            await finalizeStream(env, session, now, reason);
            return authMethod;
        }

        const minInterval = parseInt(env.MIN_POLL_INTERVAL_MS, 10);
        const updated = {
            ...session,
            consecutive_fetch_errors: strikes,
            next_poll_at: new Date(now.getTime() + Math.max(minInterval, 5000)).toISOString(),
        };
        await kvSet(env, `session.${session.date}`, updated);
        await audit(env, "poller", null, "poll_fetch_error", "stream", session.stream_id,
            null, { strikes, elapsed_min: Math.round(elapsedMin), msg: msg.slice(0, 200) });
        return authMethod;
    }

    // Successful fetch — clear quota circuit breaker if it was tripped.
    await env.DB.prepare("DELETE FROM kv WHERE k = 'circuit.youtube_quota'").run();

    const items = data.items || [];
    const minInterval = parseInt(env.MIN_POLL_INTERVAL_MS, 10);
    const interval = Math.max(minInterval, parseInt(data.pollingIntervalMillis || "5000", 10));

    await appendRawJsonl(env, session, items);
    await processCodeMatches(env, session, items, now);
    await processAttendance(env, session, items, now);
    await extractShowLinks(env, session, items, now);

    await env.DB.prepare("UPDATE streams SET messages_scanned = messages_scanned + ?1 WHERE id = ?2")
        .bind(items.length, session.stream_id).run();

    const updated = {
        ...session,
        page_token: data.nextPageToken || null,
        next_poll_at: new Date(now.getTime() + interval).toISOString(),
        consecutive_fetch_errors: 0,
    };

    if (!data.nextPageToken) {
        await finalizeStream(env, updated, now, "no_next_page_token");
        return authMethod;
    }
    await kvSet(env, `session.${session.date}`, updated);
    return authMethod;
}

async function processCodeMatches(env, session, items, now) {
    // Anti-race: a verification code posted in YouTube live chat is visible
    // to every viewer. An attacker tailing chat can copy a fresh code and
    // post it from their own channel before the legitimate user does — first
    // poll wins, attacker's channel gets bound to the victim's account.
    //
    // Defence: scan the whole batch for each code first. If two distinct
    // channels posted the same code, refuse to bind either of them and let
    // the user re-request a fresh code via /api/me/{token}/resend-code.
    // The code is then burned (cleared) so the attacker can't replay it on
    // a future poll.
    const contestedCodes = detectContestedCodes(items);
    const rule = await loadRule(env);
    const startMs = new Date(session.actual_start_at).getTime();
    const windowOpenMs = Number.isFinite(startMs)
        ? startMs - rule.pre_start_grace_min * 60_000
        : null;

    for (const m of items) {
        const text = m.snippet?.displayMessage || "";
        const match = CODE_RE.exec(text);
        if (!match) continue;
        const code = extractCode(match);
        const channelId = m.authorDetails?.channelId;
        if (!channelId) continue;

        const user = await env.DB.prepare(
            "SELECT id, email, legal_name, yt_channel_id, code_expires_at, state FROM users WHERE verification_code = ?1"
        ).bind(code).first();

        if (!user) continue;
        // Process codes from pending users (normal flow) and active users
        // whose YouTube channel isn't linked yet (admin-reconciled credits
        // set state='active' without binding a channel).
        const needsLink = user.state === "pending_verification"
            || (user.state === "active" && !user.yt_channel_id);
        if (!needsLink) continue;
        if (new Date(user.code_expires_at) < now) {
            await audit(env, "poller", user.id, "code_expired_at_use", "user", user.id, null, { code });
            continue;
        }

        // Time-gate: reject codes posted outside the live window. Without
        // this a user could drop their code in pre-stream chat hours before
        // the briefing starts and earn a cert that claims "attended live"
        // for a session they didn't actually watch. We do NOT burn the code
        // here — legit user can retry during the live window.
        const pubMs = new Date(m.snippet?.publishedAt || 0).getTime();
        if (windowOpenMs !== null && Number.isFinite(pubMs) && pubMs < windowOpenMs) {
            await audit(env, "poller", user.id, "code_posted_outside_window", "user",
                user.id, null, {
                    code, stream_id: session.stream_id,
                    posted_at: m.snippet?.publishedAt,
                    window_open_at: new Date(windowOpenMs).toISOString(),
                });
            continue;
        }

        if (contestedCodes.has(code)) {
            // Two channels in the same batch posted this code → likely a
            // race attack. Burn the code so neither party can use it; user
            // must re-request via the dashboard.
            await env.DB.prepare(
                "UPDATE users SET verification_code = NULL, code_expires_at = NULL WHERE id = ?1"
            ).bind(user.id).run();
            await audit(env, "poller", user.id, "code_race_detected", "user", user.id,
                null, { code, channels: [...new Set(items
                    .filter(x => { const m = CODE_RE.exec(x.snippet?.displayMessage || ""); return m && extractCode(m) === code; })
                    .map(x => x.authorDetails?.channelId).filter(Boolean))],
                    stream_id: session.stream_id });
            continue;
        }

        const conflict = await env.DB.prepare(
            "SELECT id FROM users WHERE yt_channel_id = ?1 AND state = 'active' AND id != ?2"
        ).bind(channelId, user.id).first();

        if (conflict) {
            await audit(env, "poller", user.id, "code_channel_conflict", "user", user.id, null, {
                code, channelId, conflicting_user: conflict.id,
            });
            continue;
        }

        await env.DB.prepare(`
            UPDATE users SET
                yt_channel_id = ?1,
                yt_display_name_seen = ?2,
                state = 'active',
                verification_code = NULL,
                verified_at = COALESCE(verified_at, ?3)
            WHERE id = ?4
        `).bind(
            channelId,
            m.authorDetails?.displayName || null,
            now.toISOString(),
            user.id,
        ).run();

        const action = user.state === "active" ? "channel_linked" : "user_verified";
        await audit(env, "poller", user.id, action, "user", user.id,
            { state: user.state, yt_channel_id: user.yt_channel_id || null },
            { state: "active", yt_channel_id: channelId, stream_id: session.stream_id });
    }
}

async function processAttendance(env, session, items, now) {
    if (items.length === 0) return;

    const rule = await loadRule(env);
    const startMs = new Date(session.actual_start_at).getTime();
    if (!Number.isFinite(startMs)) {
        // No usable start timestamp — without it the grace window collapses
        // to NaN and `< NaN` is always false, which would silently credit
        // every chat message regardless of timing. Fail closed instead.
        console.warn("processAttendance:bad_actual_start_at", {
            stream_id: session.stream_id, actual_start_at: session.actual_start_at,
        });
        return;
    }
    const windowOpenMs = startMs - rule.pre_start_grace_min * 60_000;

    const channelIds = [...new Set(
        items.map(m => m.authorDetails?.channelId).filter(Boolean)
    )];
    if (channelIds.length === 0) return;

    const placeholders = channelIds.map((_, i) => `?${i + 1}`).join(",");
    const usersRs = await env.DB.prepare(
        `SELECT id, yt_channel_id FROM users WHERE state = 'active' AND yt_channel_id IN (${placeholders})`
    ).bind(...channelIds).all();
    const byChannel = new Map((usersRs.results || []).map(r => [r.yt_channel_id, r.id]));
    if (byChannel.size === 0) return;

    for (const m of items) {
        const cid = m.authorDetails?.channelId;
        const userId = byChannel.get(cid);
        if (!userId) continue;

        const text = (m.snippet?.displayMessage || "").trim();
        if (!passesMessageFilter(text, rule.min_msg_len)) continue;

        const publishedAt = m.snippet?.publishedAt;
        if (!publishedAt) continue;
        if (new Date(publishedAt).getTime() < windowOpenMs) {
            // Seen, but out of window. Log once per (user, stream) so the
            // dashboard can show the user why they didn't get credit, and
            // so the audit chain retains evidence that the system noticed.
            const already = await env.DB.prepare(
                `SELECT 1 FROM audit_log WHERE action = 'attendance_outside_window'
                 AND entity_type = 'user' AND entity_id = ?1
                 AND after_json LIKE ?2 LIMIT 1`
            ).bind(userId, `%"stream_id":"${session.stream_id}"%`).first();
            if (!already) {
                await audit(env, "poller", userId, "attendance_outside_window", "user",
                    userId, null, {
                        stream_id: session.stream_id,
                        posted_at: publishedAt,
                        window_open_at: new Date(windowOpenMs).toISOString(),
                    });
            }
            continue;
        }

        const existing = await env.DB.prepare(
            "SELECT user_id FROM attendance WHERE user_id = ?1 AND stream_id = ?2"
        ).bind(userId, session.stream_id).first();
        if (existing) continue;

        const sha = await sha256Hex(text);
        await env.DB.prepare(`
            INSERT OR IGNORE INTO attendance
              (user_id, stream_id, earned_cpe, first_msg_id, first_msg_at,
               first_msg_sha256, first_msg_len, rule_version, source, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'poll', ?9)
        `).bind(
            userId, session.stream_id, rule.cpe_per_day,
            m.id, publishedAt, sha, text.length, rule.version,
            now.toISOString(),
        ).run();

        await env.DB.prepare(
            "UPDATE streams SET distinct_attendees = distinct_attendees + 1 WHERE id = ?1"
        ).bind(session.stream_id).run();

        await audit(env, "poller", userId, "attendance_credited", "attendance",
            `${userId}:${session.stream_id}`, null,
            { stream_id: session.stream_id, cpe: rule.cpe_per_day, rule_version: rule.version });
    }
}

async function extractShowLinks(env, session, items, now) {
    for (const m of items) {
        const isOwner = m.authorDetails?.isOwner === true;
        const isMod = m.authorDetails?.isModerator === true;
        if (!isOwner && !isMod) continue;

        const text = m.snippet?.displayMessage || "";
        const urls = text.match(URL_RE);
        if (!urls) continue;

        for (let raw of urls) {
            raw = raw.replace(/[.,;:!?]+$/, "");
            let parsed;
            try { parsed = new URL(raw); } catch { continue; }
            if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;

            await env.DB.prepare(`
                INSERT OR IGNORE INTO show_links
                  (id, stream_id, url, domain, author_type, author_name,
                   yt_channel_id, yt_message_id, posted_at, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            `).bind(
                ulid(),
                session.stream_id,
                raw,
                parsed.hostname,
                isOwner ? "owner" : "moderator",
                m.authorDetails?.displayName || "Unknown",
                m.authorDetails?.channelId || "",
                m.id,
                m.snippet?.publishedAt || now.toISOString(),
                now.toISOString(),
            ).run();
        }
    }
}

function passesMessageFilter(text, minLen) {
    if (text.length < minLen) return false;
    // Reject pure emoji / whitespace / zero-width by requiring at least one
    // letter or digit anywhere in the message.
    return /[\p{L}\p{N}]/u.test(text);
}

async function loadRule(env) {
    const rs = await env.DB.prepare(
        "SELECT k, v FROM kv WHERE k LIKE 'rule_version.%'"
    ).all();
    const m = Object.fromEntries((rs.results || []).map(r => [r.k, r.v]));
    const v = parseInt(m["rule_version.current"] || "1", 10);
    return {
        version: v,
        min_msg_len: parseInt(m[`rule_version.${v}.min_msg_len`] || "3", 10),
        pre_start_grace_min: parseInt(m[`rule_version.${v}.pre_start_grace_min`] || "15", 10),
        cpe_per_day: parseFloat(m[`rule_version.${v}.cpe_per_day`] || "0.5"),
        finalize_settle_min: parseInt(m[`rule_version.${v}.finalize_settle_min`] || "5", 10),
    };
}

async function appendRawJsonl(env, session, items) {
    if (items.length === 0) return;
    const key = `raw/${session.date}/${session.video_id}/page-${Date.now()}.jsonl`;
    const lines = items.map(m => JSON.stringify({
        id: m.id,
        publishedAt: m.snippet?.publishedAt,
        channelId: m.authorDetails?.channelId,
        displayName: m.authorDetails?.displayName,
        message: m.snippet?.displayMessage,
        type: m.snippet?.type,
    })).join("\n") + "\n";
    await env.RAW_CHAT.put(key, lines);
}

async function upsertStream(env, discovered, now) {
    const id = ulid();
    const purgeAfter = new Date(now.getTime() + 7 * 864e5).toISOString();
    const date = isoDate(now);
    await env.DB.prepare(`
        INSERT INTO streams (id, yt_video_id, yt_live_chat_id, title, scheduled_date,
                             actual_start_at, state, raw_r2_key, raw_purge_after, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'live', ?7, ?8, ?9)
        ON CONFLICT(yt_video_id) DO UPDATE SET
            yt_live_chat_id = excluded.yt_live_chat_id,
            actual_start_at = excluded.actual_start_at
    `).bind(
        id, discovered.videoId, discovered.liveChatId, discovered.title, date,
        discovered.actualStartTime, `raw/${date}/${discovered.videoId}/`,
        purgeAfter, now.toISOString(),
    ).run();

    const row = await env.DB.prepare("SELECT id FROM streams WHERE yt_video_id = ?1")
        .bind(discovered.videoId).first();
    return row.id;
}

async function finalizeStream(env, session, now, reason) {
    // A stream that completes with no messages scanned is always suspicious:
    // either the poller mis-finalized (see FINALIZE_ERROR_STRIKES guard) or
    // YouTube returned empty pages for a stream we know started. Flag it so
    // an operator can verify rather than silently letting attendance go to
    // zero for the day.
    const row = await env.DB.prepare(
        "SELECT messages_scanned FROM streams WHERE id = ?1"
    ).bind(session.stream_id).first();
    const zeroMessages = !row || (row.messages_scanned || 0) === 0;
    const finalState = zeroMessages ? "flagged" : "complete";

    await env.DB.prepare(
        "UPDATE streams SET state = ?1, actual_end_at = ?2, flag_reason = ?3 WHERE id = ?4"
    ).bind(finalState, now.toISOString(), reason, session.stream_id).run();
    await kvSet(env, `session.${session.date}`, { ...session, state: finalState });
    await audit(env, "poller", null, "stream_completed", "stream", session.stream_id,
        null, { reason, ended_at: now.toISOString(), state: finalState,
                messages_scanned: row?.messages_scanned ?? 0 });
    if (zeroMessages) {
        await audit(env, "poller", null, "stream_zero_messages_anomaly", "stream",
            session.stream_id, null,
            { reason, elapsed_min: Math.round(
                (now.getTime() - new Date(session.actual_start_at).getTime()) / 60_000) });
    }
}

async function ytGet(url, accessToken) {
    const headers = {};
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`YT ${res.status}: ${body.slice(0, 500)}`);
        }
        const json = await res.json();
        if (json?.error?.errors?.some(e => /quotaExceeded/i.test(e.reason || ""))) {
            throw new Error(`YT 200 (quota): ${JSON.stringify(json.error).slice(0, 500)}`);
        }
        return json;
    } finally {
        clearTimeout(timer);
    }
}

async function kvSet(env, k, obj) {
    const now = new Date().toISOString();
    await env.DB.prepare(`
        INSERT INTO kv (k, v, updated_at) VALUES (?1, ?2, ?3)
        ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
    `).bind(k, JSON.stringify(obj), now).run();
}

async function loadSession(env, date) {
    const row = await env.DB.prepare("SELECT v FROM kv WHERE k = ?1")
        .bind(`session.${date}`).first();
    return row ? JSON.parse(row.v) : null;
}

async function heartbeat(env, source, status, detail) {
    const now = new Date().toISOString();
    await env.DB.prepare(`
        INSERT INTO heartbeats (source, last_beat_at, last_status, detail_json)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(source) DO UPDATE SET
            last_beat_at = excluded.last_beat_at,
            last_status = excluded.last_status,
            detail_json = excluded.detail_json
    `).bind(source, now, status, JSON.stringify(detail)).run();
}

// Canonical audit-row serialisation — MUST match pages/functions/_lib.js and
// scripts/verify_audit_chain.py byte-for-byte. Any drift breaks the chain.
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

function isoDate(d) { return d.toISOString().slice(0, 10); }

function ulid() {
    const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let ts = "", n = Date.now();
    for (let i = 9; i >= 0; i--, n = Math.floor(n / 32)) ts = A[n % 32] + ts;
    const rnd = crypto.getRandomValues(new Uint8Array(16));
    let r = "";
    for (let i = 0; i < 16; i++) r += A[rnd[i] % 32];
    return ts + r;
}
