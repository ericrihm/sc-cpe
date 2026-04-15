import { json } from "../../_lib.js";

// GET /api/preflight/channel?q=<channel-id-or-url>
//
// Lightweight availability check so a pending user can verify, before they
// post their verification code in live chat, that the YouTube channel they
// intend to post from is (a) a well-formed channel id and (b) not already
// bound to another active SC-CPE account.
//
// The poller already refuses to bind a channel that's taken (see
// workers/poller/src/index.js, processCodeMatches conflict branch). Without
// this pre-flight the user only discovers the conflict by posting the code,
// seeing the poller silently skip it, and having the code expire. This
// endpoint converts that into an up-front, fixable error.
//
// Accepts either:
//   - a bare channel id: UCxxxxxxxxxxxxxxxxxxxx (24 chars starting UC)
//   - a youtube.com/channel/<id> URL
//   - a youtube.com/@handle URL  → 400 (we can't resolve handles to IDs
//                                      without burning quota)
//
// Does NOT validate that the channel actually exists on YouTube — that
// would require an API call per hit. Format + uniqueness is enough to
// catch the common mistake (wrong account, already-bound account).
const CHANNEL_ID_RE = /^UC[0-9A-Za-z_-]{22}$/;

function extractChannelId(q) {
    q = (q || "").trim();
    if (!q) return { error: "empty" };
    if (CHANNEL_ID_RE.test(q)) return { id: q };
    let url;
    try { url = new URL(q); }
    catch { return { error: "not_a_channel_id_or_url" }; }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!["youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
        return { error: "not_a_youtube_url" };
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "channel" && parts[1] && CHANNEL_ID_RE.test(parts[1])) {
        return { id: parts[1] };
    }
    if (parts[0]?.startsWith("@")) {
        return { error: "handle_not_supported_use_channel_id" };
    }
    return { error: "could_not_extract_channel_id" };
}

export async function onRequestGet({ request, env }) {
    const url = new URL(request.url);
    const q = url.searchParams.get("q");

    const parsed = extractChannelId(q);
    if (parsed.error) {
        return json({ valid: false, error: parsed.error }, 400);
    }

    const taken = await env.DB.prepare(
        "SELECT id FROM users WHERE yt_channel_id = ?1 AND state = 'active'"
    ).bind(parsed.id).first();

    return json({
        valid: true,
        normalized: parsed.id,
        available: !taken,
        // Do not leak which user owns it. "taken" is enough signal for the
        // prospective user to realise they're looking at the wrong account.
    });
}
