#!/usr/bin/env node
// Backfill show_links from Discord #live-chat channel history.
// Uses Discord HTTP API with a user auth token, rate-limited to 1 req/2sec.
// Writes to D1 via wrangler d1 execute (same pattern as seed_demo.mjs).
//
// Usage:
//   source ~/.cloudflare/signalplane.env
//   export DISCORD_TOKEN="$(cat ~/.discord-token)"
//   export DISCORD_CHANNEL_ID="<channel-id>"
//   node scripts/backfill_discord_links.mjs
//
// Options (env):
//   BACKFILL_DAYS=100     How far back to go (default 100)
//   DISCORD_DELAY_MS=2000 Pause between Discord API calls (default 2000)
//   DRY_RUN=1             Log what would be inserted without writing to D1

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Config ---
const token = process.env.DISCORD_TOKEN
    || readFileSync(join(homedir(), ".discord-token"), "utf8").trim();
const channelId = process.env.DISCORD_CHANNEL_ID;
const backfillDays = parseInt(process.env.BACKFILL_DAYS || "100", 10);
const delayMs = parseInt(process.env.DISCORD_DELAY_MS || "2000", 10);
const dryRun = process.env.DRY_RUN === "1";

if (!token) { console.error("DISCORD_TOKEN required (env or ~/.discord-token)"); process.exit(1); }
if (!channelId) { console.error("DISCORD_CHANNEL_ID required"); process.exit(1); }

const cutoff = new Date(Date.now() - backfillDays * 86400_000);
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

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

async function discordGetWithRetry(path) {
    while (true) {
        await sleep(delayMs);
        const result = await discordGet(path);
        if (result && result.rateLimited) {
            const wait = Math.ceil(result.retryAfter * 1000) + 500;
            console.log(`  [rate-limited] waiting ${wait}ms...`);
            await sleep(wait);
            continue;
        }
        return result;
    }
}

// --- D1 helpers (same pattern as seed_demo.mjs) ---
const spawnEnv = { ...process.env };

function d1(cmd) {
    const out = execFileSync("npx",
        ["wrangler", "d1", "execute", "sc-cpe", "--remote", "--json", "--command", cmd],
        { encoding: "utf8", cwd: "pages", timeout: 30_000, env: spawnEnv });
    return JSON.parse(out);
}

function d1File(path) {
    execFileSync("npx",
        ["wrangler", "d1", "execute", "sc-cpe", "--remote", `--file=${path}`],
        { stdio: "inherit", cwd: "pages", timeout: 60_000, env: spawnEnv });
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
    const streamsResult = d1(
        `SELECT id, scheduled_date FROM streams WHERE scheduled_date >= '${cutoffDate}' ORDER BY scheduled_date`
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
        if (userId === ownerId) return "owner";

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

    let page = 0;
    let beforeId = undefined;
    let totalScanned = 0;
    let totalLinks = 0;
    let counts = { owner: 0, moderator: 0, viewer: 0 };
    let allStmts = [];
    let done = false;

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
            const streamId = streamsByDate.get(etDate);
            if (!streamId) continue;

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

                const stmt = `INSERT OR IGNORE INTO show_links (id, stream_id, url, domain, author_type, author_name, yt_channel_id, yt_message_id, posted_at, created_at) VALUES (${sqlEsc(ulid())}, ${sqlEsc(streamId)}, ${sqlEsc(raw)}, ${sqlEsc(parsed.hostname)}, ${sqlEsc(authorType)}, ${sqlEsc(authorName)}, ${sqlEsc("discord:" + msg.author.id)}, ${sqlEsc("discord:" + msg.id)}, ${sqlEsc(msg.timestamp)}, ${sqlEsc(new Date().toISOString())});`;
                allStmts.push(stmt);
            }
        }

        console.log(`[page ${page}] ${totalScanned} msgs scanned, ${totalLinks} links found (${counts.owner} owner, ${counts.moderator} mod, ${counts.viewer} viewer), oldest: ${oldestDate.toISOString().slice(0, 10)}`);

        if (oldestDate < cutoff) break;
    }

    console.log(`\n=== Scan complete ===`);
    console.log(`Pages: ${page}`);
    console.log(`Messages scanned: ${totalScanned}`);
    console.log(`Links found: ${totalLinks} (${counts.owner} owner, ${counts.moderator} mod, ${counts.viewer} viewer)`);
    console.log(`Member cache entries: ${memberCache.size}`);

    if (allStmts.length === 0) {
        console.log("\nNo links to insert.");
        return;
    }

    if (dryRun) {
        console.log(`\n[DRY RUN] Would insert ${allStmts.length} rows. Sample:`);
        for (const s of allStmts.slice(0, 5)) console.log(`  ${s.slice(0, 120)}...`);
        return;
    }

    // Write to D1 via temp file (same pattern as seed_demo.mjs)
    const sqlPath = "/tmp/backfill_discord_links.sql";
    writeFileSync(sqlPath, allStmts.join("\n") + "\n");
    console.log(`\nWriting ${allStmts.length} rows to D1...`);
    d1File(sqlPath);
    unlinkSync(sqlPath);
    console.log("Done.");
}

main().catch(err => { console.error(err); process.exit(1); });
