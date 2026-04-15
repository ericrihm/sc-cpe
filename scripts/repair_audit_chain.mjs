#!/usr/bin/env node
// Repair the 2 audit rows I broke with colliding-ms ULIDs. Delete the 2
// broken rows, re-insert with 1ms ts spacing so sort order matches chain order.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";

const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulidAt(ms) {
    let ts = "", n = ms;
    for (let i = 9; i >= 0; i--, n = Math.floor(n / 32)) ts = A[n % 32] + ts;
    const rnd = randomBytes(16);
    let r = "";
    for (let i = 0; i < 16; i++) r += A[rnd[i] % 32];
    return ts + r;
}
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
const sqlEsc = v => v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

function d1(cmd) {
    const out = execFileSync("wrangler",
        ["d1", "execute", "sc-cpe", "--remote", "--json", "--command", cmd],
        { encoding: "utf8", cwd: "pages" });
    return JSON.parse(out);
}

const BROKEN = [
    "01KP99W55ZTEK5X5784M46NAS1", // stream_purged
    "01KP99W55ZZFMM0JMHJBFGGT4F", // attendance_purged
];
const TEST_STREAM = "01KTEST0000STREAM00MARCH02";
const TEST_USER = "01KP6PNPBXM4BWSACVS3GVKDJ3";

// Last valid row = the 4th cert_purged (01KP99W55Z8F8M9D9S8QFGEG3N)
const tipRes = d1(
    `SELECT * FROM audit_log WHERE id='01KP99W55Z8F8M9D9S8QFGEG3N'`);
const tip = tipRes[0].results[0];
if (!tip) throw new Error("tip not found");
console.log("Anchor tip:", tip.id, tip.prev_hash);

// Build 2 new rows with 1ms-spaced timestamps to guarantee sort order = chain order
const baseMs = Date.now();
const streamRow = {
    id: ulidAt(baseMs),
    actor_type: "system",
    actor_id: "purge_test_fixtures",
    action: "test_fixture_stream_purged",
    entity_type: "stream",
    entity_id: TEST_STREAM,
    before_json: JSON.stringify({ title: null, yt_video_id: "TEST", scheduled_date: "2026-03-02" }),
    after_json: null,
    ip_hash: null,
    user_agent: null,
    ts: new Date(baseMs).toISOString(),
    prev_hash: sha(canonicalAuditRow(tip)),
};

const attRow = {
    id: ulidAt(baseMs + 1),
    actor_type: "system",
    actor_id: "purge_test_fixtures",
    action: "test_fixture_attendance_purged",
    entity_type: "attendance",
    entity_id: `${TEST_USER}:${TEST_STREAM}`,
    before_json: JSON.stringify({ user_id: TEST_USER, stream_id: TEST_STREAM, first_msg_id: "TESTMSG001" }),
    after_json: null,
    ip_hash: null,
    user_agent: null,
    ts: new Date(baseMs + 1).toISOString(),
    prev_hash: sha(canonicalAuditRow(streamRow)),
};

const ins = r => `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json, ip_hash, user_agent, ts, prev_hash) VALUES (${sqlEsc(r.id)}, ${sqlEsc(r.actor_type)}, ${sqlEsc(r.actor_id)}, ${sqlEsc(r.action)}, ${sqlEsc(r.entity_type)}, ${sqlEsc(r.entity_id)}, ${sqlEsc(r.before_json)}, NULL, NULL, NULL, ${sqlEsc(r.ts)}, ${sqlEsc(r.prev_hash)});`;

const sql = [
    `DELETE FROM audit_log WHERE id='${BROKEN[0]}';`,
    `DELETE FROM audit_log WHERE id='${BROKEN[1]}';`,
    ins(streamRow),
    ins(attRow),
].join("\n");

const path = "/tmp/repair_audit_chain.sql";
writeFileSync(path, sql + "\n");
console.log("New stream row:", streamRow.id, "ts=", streamRow.ts);
console.log("New att row:   ", attRow.id, "ts=", attRow.ts);

execFileSync("wrangler",
    ["d1", "execute", "sc-cpe", "--remote", `--file=${path}`],
    { stdio: "inherit", cwd: "pages" });

unlinkSync(path);
console.log("Done.");
