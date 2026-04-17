#!/usr/bin/env node
// Seed demo fixtures into prod D1 for demonstration purposes.
// All inserts go via wrangler d1 execute (no admin API needed).
// Audit chain is extended locally, matching the canonical form.
//
// Test-detectable markers (ops-stats will flag these):
//   - User emails: @example.com
//   - Stream IDs: start with 01KTEST
//   - yt_video_id: starts with TEST
//   - first_msg_sha256: 'deadbeef'
//   - first_msg_id: starts with TESTMSG
//
// Usage:
//   source ~/.cloudflare/signalplane.env
//   node scripts/seed_demo.mjs          # seed
//   node scripts/seed_demo.mjs --purge  # remove seeded data
//
// Requires: wrangler authenticated (CLOUDFLARE_API_TOKEN in env)

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";

const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid() {
    let ts = "", n = Date.now();
    for (let i = 9; i >= 0; i--, n = Math.floor(n / 32)) ts = A[n % 32] + ts;
    const rnd = randomBytes(16);
    let r = "";
    for (let i = 0; i < 16; i++) r += A[rnd[i] % 32];
    return ts + r;
}
const randomToken = () => randomBytes(32).toString("hex");
const randomCode = () => {
    const rnd = randomBytes(8);
    let s = "";
    for (let i = 0; i < 8; i++) s += A[rnd[i] % 32];
    return s;
};
const sqlEsc = v => v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

function canonicalAuditRow(r) {
    return JSON.stringify([
        r.id, r.actor_type, r.actor_id ?? null, r.action,
        r.entity_type, r.entity_id,
        r.before_json ?? null, r.after_json ?? null,
        r.ip_hash ?? null, r.user_agent ?? null,
        r.ts, r.prev_hash ?? null,
    ]);
}
const sha = s => createHash("sha256").update(s).digest("hex");

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

// --- Config ---
const now = new Date();
const yyyy = now.getUTCFullYear();
const mm = String(now.getUTCMonth() + 1).padStart(2, "0");

const DEMO_USERS = [
    { name: "Alex Thompson",  email: "alex.thompson@example.com",  sessions: 12 },
    { name: "Morgan Chen",    email: "morgan.chen@example.com",    sessions: 10 },
    { name: "Jordan Rivera",  email: "jordan.rivera@example.com",  sessions: 8 },
    { name: "Casey Williams", email: "casey.williams@example.com", sessions: 6 },
    { name: "Taylor Kim",     email: "taylor.kim@example.com",     sessions: 4 },
    { name: "Sam Patel",      email: "sam.patel@example.com",      sessions: 3 },
    { name: "Riley Scott",    email: "riley.scott@example.com",    sessions: 2 },
    { name: "Jamie Lopez",    email: "jamie.lopez@example.com",    sessions: 1 },
];

function makeStreams(count) {
    const out = [];
    for (let i = 1; i <= count; i++) {
        const day = String(i).padStart(2, "0");
        out.push({
            id: `01KTEST${yyyy}${mm}STRM${day}`.padEnd(26, "0"),
            yt_video_id: `TESTvid${yyyy}${mm}${day}`,
            title: `Daily Threat Briefing — ${yyyy}-${mm}-${day}`,
            scheduled_date: `${yyyy}-${mm}-${day}`,
            actual_start_at: `${yyyy}-${mm}-${day}T13:00:00Z`,
            actual_end_at: `${yyyy}-${mm}-${day}T14:00:00Z`,
        });
    }
    return out;
}

// --- Purge mode ---
if (process.argv.includes("--purge")) {
    console.log("Purging demo fixtures...\n");

    const tipRes = d1(
        `SELECT id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json, ip_hash, user_agent, ts, prev_hash FROM audit_log ORDER BY ts DESC, id DESC LIMIT 1`);
    let tip = tipRes[0].results[0];
    if (!tip) { console.error("No audit tip found — DB empty?"); process.exit(1); }
    console.log("Audit tip:", tip.id, tip.action);

    const stmts = [];
    function appendAudit(action, entityType, entityId) {
        const row = {
            id: ulid(), actor_type: "system", actor_id: "purge_demo_fixtures",
            action, entity_type: entityType, entity_id: entityId,
            before_json: null, after_json: null, ip_hash: null, user_agent: null,
            ts: new Date().toISOString(), prev_hash: sha(canonicalAuditRow(tip)),
        };
        tip = row;
        stmts.push(
            `INSERT INTO audit_log (id,actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_hash,user_agent,ts,prev_hash) VALUES (${sqlEsc(row.id)},${sqlEsc(row.actor_type)},${sqlEsc(row.actor_id)},${sqlEsc(row.action)},${sqlEsc(row.entity_type)},${sqlEsc(row.entity_id)},NULL,NULL,NULL,NULL,${sqlEsc(row.ts)},${sqlEsc(row.prev_hash)});`
        );
    }

    appendAudit("demo_fixtures_purged", "system", "demo_seed");

    stmts.push(`DELETE FROM attendance WHERE first_msg_sha256 = 'deadbeef';`);
    stmts.push(`DELETE FROM certs WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com');`);
    stmts.push(`DELETE FROM streams WHERE id LIKE '01KTEST%';`);
    stmts.push(`DELETE FROM users WHERE email LIKE '%@example.com';`);

    const path = "/tmp/purge_demo.sql";
    writeFileSync(path, stmts.join("\n") + "\n");
    console.log(`Executing ${stmts.length} statements...`);
    d1File(path);
    unlinkSync(path);
    console.log("\nPurge complete.");
    process.exit(0);
}

// --- Seed mode ---
console.log("Seeding demo fixtures...\n");

// Fetch audit tip for chain extension
const tipRes = d1(
    `SELECT id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json, ip_hash, user_agent, ts, prev_hash FROM audit_log ORDER BY ts DESC, id DESC LIMIT 1`);
let tip = tipRes[0].results[0];
if (!tip) { console.error("No audit tip found — DB empty?"); process.exit(1); }
console.log("Audit tip:", tip.id, tip.action, "\n");

const allStmts = [];

function appendAudit(action, entityType, entityId, afterObj) {
    const row = {
        id: ulid(), actor_type: "system", actor_id: "seed_demo",
        action, entity_type: entityType, entity_id: entityId,
        before_json: null,
        after_json: afterObj ? JSON.stringify(afterObj) : null,
        ip_hash: null, user_agent: null,
        ts: new Date().toISOString(), prev_hash: sha(canonicalAuditRow(tip)),
    };
    tip = row;
    allStmts.push(
        `INSERT INTO audit_log (id,actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_hash,user_agent,ts,prev_hash) VALUES (${sqlEsc(row.id)},${sqlEsc(row.actor_type)},${sqlEsc(row.actor_id)},${sqlEsc(row.action)},${sqlEsc(row.entity_type)},${sqlEsc(row.entity_id)},NULL,${sqlEsc(row.after_json)},NULL,NULL,${sqlEsc(row.ts)},${sqlEsc(row.prev_hash)});`
    );
}

const maxSessions = Math.max(...DEMO_USERS.map(u => u.sessions));
const streams = makeStreams(maxSessions);

// 1. Streams
console.log(`Creating ${streams.length} test streams...`);
for (const s of streams) {
    allStmts.push(
        `INSERT OR IGNORE INTO streams (id, yt_video_id, yt_live_chat_id, title, scheduled_date, actual_start_at, actual_end_at, state, messages_scanned, distinct_attendees, created_at) VALUES (${sqlEsc(s.id)}, ${sqlEsc(s.yt_video_id)}, NULL, ${sqlEsc(s.title)}, ${sqlEsc(s.scheduled_date)}, ${sqlEsc(s.actual_start_at)}, ${sqlEsc(s.actual_end_at)}, 'complete', 100, 0, ${sqlEsc(now.toISOString())});`
    );
}
appendAudit("demo_streams_seeded", "system", "demo_seed", { count: streams.length });

// 2. Users
console.log(`Creating ${DEMO_USERS.length} test users...`);
const userRecords = DEMO_USERS.map(u => ({
    ...u,
    id: ulid(),
    dashboard_token: randomToken(),
    verification_code: randomCode(),
}));

for (const u of userRecords) {
    allStmts.push(
        `INSERT OR IGNORE INTO users (id, email, legal_name, yt_channel_id, verification_code, code_expires_at, dashboard_token, state, email_prefs, legal_name_attested, age_attested_13plus, tos_version_accepted, created_at, verified_at, show_on_leaderboard) VALUES (${sqlEsc(u.id)}, ${sqlEsc(u.email)}, ${sqlEsc(u.name)}, ${sqlEsc('UCtest_' + u.email.split('@')[0])}, ${sqlEsc(u.verification_code)}, NULL, ${sqlEsc(u.dashboard_token)}, 'active', '{"monthly_cert":true}', 1, 1, '1.0', ${sqlEsc(now.toISOString())}, ${sqlEsc(now.toISOString())}, 1);`
    );
}
appendAudit("demo_users_seeded", "system", "demo_seed", { count: userRecords.length });

// 3. Attendance
let attendanceCount = 0;
console.log("Granting attendance...");
for (const u of userRecords) {
    const userStreams = streams.slice(0, u.sessions);
    for (const s of userStreams) {
        const msgIdx = String(++attendanceCount).padStart(4, "0");
        allStmts.push(
            `INSERT OR IGNORE INTO attendance (user_id, stream_id, earned_cpe, first_msg_id, first_msg_at, first_msg_sha256, first_msg_len, rule_version, source, created_at) VALUES (${sqlEsc(u.id)}, ${sqlEsc(s.id)}, 0.5, ${sqlEsc(`TESTMSG${msgIdx}`)}, ${sqlEsc(s.actual_start_at)}, 'deadbeef', 20, 1, 'admin_manual', ${sqlEsc(now.toISOString())});`
        );
    }
    appendAudit("attendance_granted_manual", "attendance", `${u.id}:demo_batch`, {
        user_id: u.id, sessions: u.sessions, reason: "Demo seed fixture",
    });
}

// 4. Update distinct_attendees on streams
for (const s of streams) {
    const count = userRecords.filter(u => u.sessions >= streams.indexOf(s) + 1).length;
    allStmts.push(
        `UPDATE streams SET distinct_attendees = ${count} WHERE id = ${sqlEsc(s.id)};`
    );
}

// Execute all
const sqlPath = "/tmp/seed_demo_all.sql";
writeFileSync(sqlPath, allStmts.join("\n") + "\n");
console.log(`\nExecuting ${allStmts.length} statements...`);
d1File(sqlPath);
unlinkSync(sqlPath);

// Summary
console.log("\n=== Seed complete ===");
console.log(`Users:      ${userRecords.length} (all @example.com, ops-stats detectable)`);
console.log(`Streams:    ${streams.length} (IDs: 01KTEST*, yt_video_id: TEST*)`);
console.log(`Attendance: ${attendanceCount} grants (first_msg_sha256: deadbeef)`);
console.log(`\nLeaderboard: https://sc-cpe-web.pages.dev/leaderboard`);
console.log(`\nDashboard URLs:`);
for (const u of userRecords) {
    console.log(`  ${u.name.padEnd(20)} ${u.sessions} sessions  https://sc-cpe-web.pages.dev/dashboard?t=${u.dashboard_token}`);
}
console.log(`\nBadge URLs:`);
for (const u of userRecords) {
    console.log(`  ${u.name.padEnd(20)} https://sc-cpe-web.pages.dev/badge?t=${u.dashboard_token}`);
}
console.log(`\nTo purge: node scripts/seed_demo.mjs --purge`);
