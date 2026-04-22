#!/usr/bin/env node
// Backfill show_links from Discord #live-chat channel history.
// Uses Discord HTTP API with a user auth token, rate-limited to 1 req/2sec.
// Writes to D1 via Cloudflare D1 HTTP API.
//
// Auto-creates stream records for weekday dates that have Discord activity
// but no existing stream in D1 (state='rescanned').
//
// Usage:
//   source ~/.cloudflare/grc-eng.env
//   export DISCORD_TOKEN="$(cat ~/.discord-token)"
//   export DISCORD_CHANNEL_ID="<channel-id>"
//   node scripts/backfill_discord_links.mjs
//
// Options (env):
//   BACKFILL_DAYS=365       How far back to go (default 365)
//   DISCORD_DELAY_MS=2000   Pause between Discord API calls (default 2000)
//   DRY_RUN=1               Log what would be inserted without writing to D1
//   HOST_USER_IDS=id1,id2   Discord user IDs to classify as "owner"

import { readFileSync } from "node:fs";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Config ---
const token = process.env.DISCORD_TOKEN
    || readFileSync(join(homedir(), ".discord-token"), "utf8").trim();
const channelId = process.env.DISCORD_CHANNEL_ID;
const backfillDays = parseInt(process.env.BACKFILL_DAYS || "365", 10);
const delayMs = parseInt(process.env.DISCORD_DELAY_MS || "2000", 10);
const dryRun = process.env.DRY_RUN === "1";

const hostUserIds = new Set(
    (process.env.HOST_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean)
);

if (!token) { console.error("DISCORD_TOKEN required (env or ~/.discord-token)"); process.exit(1); }
if (!channelId) { console.error("DISCORD_CHANNEL_ID required"); process.exit(1); }

const cutoff = new Date(Date.now() - backfillDays * 86400_000);
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

function isWeekday(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const day = new Date(y, m - 1, d).getDay();
    return day >= 1 && day <= 5;
}

// --- ULID (same pattern as seed_demo.mjs) ---
const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid() {
    let ts = "", n = Date.now();
    for (let i = 9; i >= 0; i--, n = Math.floor(n / 32)) ts = A[n % 32] + ts;
    const rnd = randomBytes(16);
    let r = "";
    for (let i = 0; i < 16; i++) r += A[rnd[i] % 32];
    return ts + r;
}

const sqlEsc = v => v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Discord API ---
function discordGet(path) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: "discord.com",
            path,
            method: "GET",
            headers: { Authorization: token, "Content-Type": "application/json" },
        };
        const req = https.request(opts, res => {
            let body = "";
            res.on("data", c => body += c);
            res.on("end", () => {
                if (res.statusCode === 429) {
                    let retryAfter;
                    try { retryAfter = JSON.parse(body).retry_after; } catch { retryAfter = 5; }
                    resolve({ rateLimited: true, retryAfter: retryAfter || 5 });
                    return;
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`Discord ${res.statusCode}: ${body}`));
                    return;
                }
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        });
        req.on("error", reject);
        req.end();
    });
}

async function discordGetWithRetry(path, maxRetries = 5) {
    for (let attempt = 0; ; attempt++) {
        await sleep(delayMs);
        let result;
        try {
            result = await discordGet(path);
        } catch (err) {
            if (attempt < maxRetries && (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND" || err.code === "EAI_AGAIN")) {
                const wait = Math.min(2000 * (attempt + 1), 15000);
                console.log(`  [${err.code}] retry ${attempt + 1}/${maxRetries} in ${wait}ms...`);
                await sleep(wait);
                continue;
            }
            throw err;
        }
        if (result && result.rateLimited) {
            const wait = Math.ceil(result.retryAfter * 1000) + 500;
            console.log(`  [rate-limited] waiting ${wait}ms...`);
            await sleep(wait);
            continue;
        }
        return result;
    }
}

// --- D1 helpers (HTTP API, no wrangler dependency) ---
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const D1_DB_ID = process.env.D1_DATABASE_ID || "28218db6-6f35-4bfb-85cd-abd2881b6049";

if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN required");
    process.exit(1);
}

function d1Post(bodyStr) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: "api.cloudflare.com",
            path: `/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DB_ID}/query`,
            method: "POST",
            headers: {
                Authorization: `Bearer ${CF_API_TOKEN}`,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(bodyStr),
            },
        };
        const req = https.request(opts, res => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data);
                    if (!parsed.success) {
                        reject(new Error(`D1 error: ${JSON.stringify(parsed.errors)}`));
                        return;
                    }
                    resolve(parsed.result);
                } catch (e) { reject(e); }
            });
        });
        req.on("error", reject);
        req.write(bodyStr);
        req.end();
    });
}

async function d1WithRetry(bodyStr, maxRetries = 3) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await d1Post(bodyStr);
        } catch (err) {
            if (attempt < maxRetries && (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND")) {
                const wait = 3000 * (attempt + 1);
                console.log(`  [D1 ${err.code}] retry ${attempt + 1}/${maxRetries} in ${wait}ms...`);
                await sleep(wait);
                continue;
            }
            throw err;
        }
    }
}

async function d1Query(sql, params = []) {
    return d1WithRetry(JSON.stringify({ sql, params }));
}

async function d1Batch(stmts) {
    const sql = stmts.join("\n");
    return d1WithRetry(JSON.stringify({ sql }));
}

// --- ET date conversion ---
function toEtDate(isoTimestamp) {
    return new Date(isoTimestamp).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// --- Main ---
async function main() {
    console.log(`Backfilling Discord links from #live-chat`);
    console.log(`  Channel: ${channelId}`);
    console.log(`  Backfill: ${backfillDays} days (cutoff: ${cutoff.toISOString().slice(0, 10)})`);
    console.log(`  Delay: ${delayMs}ms between API calls`);
    console.log(`  Host user IDs: ${hostUserIds.size ? [...hostUserIds].join(", ") : "(server owner only)"}`);
    console.log(`  Dry run: ${dryRun}\n`);

    // 1. Fetch channel info to get guild_id
    console.log("Fetching channel info...");
    const channel = await discordGetWithRetry(`/api/v10/channels/${channelId}`);
    const guildId = channel.guild_id;
    if (!guildId) { console.error("Channel is not in a guild"); process.exit(1); }
    console.log(`  Guild: ${guildId}\n`);

    // 2. Fetch guild to get owner_id
    console.log("Fetching guild info...");
    const guild = await discordGetWithRetry(`/api/v10/guilds/${guildId}`);
    const ownerId = guild.owner_id;
    console.log(`  Owner: ${ownerId}\n`);

    // 3. Fetch guild roles to identify admin/mod role IDs
    console.log("Fetching guild roles...");
    const roles = await discordGetWithRetry(`/api/v10/guilds/${guildId}/roles`);
    const ADMINISTRATOR = 1n << 3n;
    const MANAGE_GUILD = 1n << 5n;
    const MODERATE_MEMBERS = 1n << 40n;
    const adminModRoleIds = new Set();
    for (const role of roles) {
        const perms = BigInt(role.permissions);
        if ((perms & ADMINISTRATOR) || (perms & MANAGE_GUILD) || (perms & MODERATE_MEMBERS)) {
            adminModRoleIds.add(role.id);
        }
    }
    console.log(`  Admin/mod roles: ${adminModRoleIds.size}\n`);

    // 4. Prefetch streams from D1
    console.log("Fetching streams from D1...");
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    const streamsResult = await d1Query(
        "SELECT id, scheduled_date FROM streams WHERE scheduled_date >= ?1 ORDER BY scheduled_date",
        [cutoffDate]
    );
    const streamsByDate = new Map();
    for (const row of streamsResult[0].results) {
        streamsByDate.set(row.scheduled_date, row.id);
    }
    console.log(`  Found ${streamsByDate.size} streams in backfill window\n`);

    // 5. Paginate messages
    const memberCache = new Map(); // user_id -> "owner" | "moderator" | "viewer"
    memberCache.set(ownerId, "owner");

    async function classifyAuthor(userId, authorRoles) {
        if (userId === ownerId || hostUserIds.has(userId)) return "owner";

        if (memberCache.has(userId)) return memberCache.get(userId);

        // Check roles from message if available
        if (authorRoles && authorRoles.length > 0) {
            for (const roleId of authorRoles) {
                if (adminModRoleIds.has(roleId)) {
                    memberCache.set(userId, "moderator");
                    return "moderator";
                }
            }
        }

        // Fetch member info for role check
        try {
            const member = await discordGetWithRetry(`/api/v10/guilds/${guildId}/members/${userId}`);
            if (member && member.roles) {
                for (const roleId of member.roles) {
                    if (adminModRoleIds.has(roleId)) {
                        memberCache.set(userId, "moderator");
                        return "moderator";
                    }
                }
            }
        } catch {
            // Member may have left the guild
        }

        memberCache.set(userId, "viewer");
        return "viewer";
    }

    const FLUSH_EVERY = 25;
    const BATCH_SIZE = 50;
    let page = 0;
    let beforeId = undefined;
    let totalScanned = 0;
    let totalLinks = 0;
    let totalWritten = 0;
    let skippedWeekend = 0;
    let counts = { owner: 0, moderator: 0, viewer: 0 };
    let pendingLinkStmts = [];
    let pendingStreamDates = [];
    const missingDates = new Set();
    let done = false;

    async function flushToD1() {
        if (pendingStreamDates.length === 0 && pendingLinkStmts.length === 0) return;
        if (dryRun) {
            totalWritten += pendingLinkStmts.length;
            pendingStreamDates = [];
            pendingLinkStmts = [];
            return;
        }
        if (pendingStreamDates.length > 0) {
            const nowIso = new Date().toISOString();
            const streamStmts = pendingStreamDates.map(date => {
                const id = streamsByDate.get(date);
                return `INSERT OR IGNORE INTO streams (id, yt_video_id, title, scheduled_date, state, created_at) VALUES (${sqlEsc(id)}, ${sqlEsc("discord-backfill-" + date)}, 'Daily Threat Briefing', ${sqlEsc(date)}, 'rescanned', ${sqlEsc(nowIso)});`;
            });
            for (let i = 0; i < streamStmts.length; i += BATCH_SIZE) {
                await d1Batch(streamStmts.slice(i, i + BATCH_SIZE));
            }
            console.log(`  [flush] created ${pendingStreamDates.length} streams`);
            pendingStreamDates = [];
        }
        if (pendingLinkStmts.length > 0) {
            for (let i = 0; i < pendingLinkStmts.length; i += BATCH_SIZE) {
                await d1Batch(pendingLinkStmts.slice(i, i + BATCH_SIZE));
            }
            totalWritten += pendingLinkStmts.length;
            console.log(`  [flush] wrote ${pendingLinkStmts.length} links (${totalWritten} total)`);
            pendingLinkStmts = [];
        }
    }

    while (!done) {
        page++;
        let url = `/api/v10/channels/${channelId}/messages?limit=100`;
        if (beforeId) url += `&before=${beforeId}`;

        const messages = await discordGetWithRetry(url);
        if (!messages || !Array.isArray(messages) || messages.length === 0) break;

        totalScanned += messages.length;
        beforeId = messages[messages.length - 1].id;
        const oldestTs = messages[messages.length - 1].timestamp;
        const oldestDate = new Date(oldestTs);

        for (const msg of messages) {
            const msgDate = new Date(msg.timestamp);
            if (msgDate < cutoff) { done = true; continue; }

            const text = msg.content || "";
            URL_RE.lastIndex = 0;
            const urlMatches = text.match(URL_RE);
            if (!urlMatches) continue;

            const etDate = toEtDate(msg.timestamp);

            if (!streamsByDate.has(etDate)) {
                if (!isWeekday(etDate)) { skippedWeekend++; continue; }
                missingDates.add(etDate);
                const newId = ulid();
                streamsByDate.set(etDate, newId);
                pendingStreamDates.push(etDate);
            }

            const streamId = streamsByDate.get(etDate);
            const authorType = await classifyAuthor(
                msg.author.id,
                msg.member?.roles
            );

            for (let raw of urlMatches) {
                raw = raw.replace(/[.,;:!?]+$/, "");
                let parsed;
                try { parsed = new URL(raw); } catch { continue; }
                if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;

                counts[authorType]++;
                totalLinks++;

                const authorName = msg.author.global_name
                    || msg.author.username
                    || "Unknown";

                pendingLinkStmts.push(`INSERT OR IGNORE INTO show_links (id, stream_id, url, domain, author_type, author_name, yt_channel_id, yt_message_id, posted_at, created_at) VALUES (${sqlEsc(ulid())}, ${sqlEsc(streamId)}, ${sqlEsc(raw)}, ${sqlEsc(parsed.hostname)}, ${sqlEsc(authorType)}, ${sqlEsc(authorName)}, ${sqlEsc("discord:" + msg.author.id)}, ${sqlEsc("discord:" + msg.id)}, ${sqlEsc(msg.timestamp)}, ${sqlEsc(new Date().toISOString())});`);
            }
        }

        console.log(`[page ${page}] ${totalScanned} msgs, ${totalLinks} links (${counts.owner}o/${counts.moderator}m/${counts.viewer}v), ${missingDates.size} new streams, oldest: ${oldestDate.toISOString().slice(0, 10)}`);

        if (page % FLUSH_EVERY === 0) await flushToD1();
        if (oldestDate < cutoff) break;
    }

    await flushToD1();

    console.log(`\n=== Scan complete ===`);
    console.log(`Pages: ${page}`);
    console.log(`Messages scanned: ${totalScanned}`);
    console.log(`Links found: ${totalLinks} (${counts.owner} owner, ${counts.moderator} mod, ${counts.viewer} viewer)`);
    console.log(`Stream records created: ${missingDates.size}`);
    console.log(`Links written to D1: ${totalWritten}`);
    console.log(`Weekend links skipped: ${skippedWeekend}`);
    console.log(`Member cache entries: ${memberCache.size}`);
    if (dryRun && missingDates.size > 0) {
        console.log(`\n[DRY RUN] Would create streams for: ${[...missingDates].sort().join(", ")}`);
    }
    console.log(totalWritten > 0 || dryRun ? "\nDone." : "\nNo new links to insert.");
}

main().catch(err => { console.error(err); process.exit(1); });
