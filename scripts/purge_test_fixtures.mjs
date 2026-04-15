#!/usr/bin/env node
// One-shot: purge seeded test fixtures from prod D1 + append audit rows
// documenting the purge. Chain extension computed locally.

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

const TEST_STREAM = "01KTEST0000STREAM00MARCH02";
const TEST_USER = "01KP6PNPBXM4BWSACVS3GVKDJ3";
const TEST_CERT_IDS = [
    "01KP7CWN7WHE681TXGT3KKTKEW",
    "01KP7DMMXH73BDB6KTXR7VRH2T",
    "01KP8D25N2AMGYRV8CHSEXHM6W",
    // 01KP7BSMGAEBJRNY9DTP0MWBJ3 (first revoked) – query to confirm
];

// Fetch all 202603 cert ids authoritatively
const certRes = d1(`SELECT id FROM certs WHERE user_id='${TEST_USER}' AND period_yyyymm='202603'`);
const certIds = certRes[0].results.map(r => r.id);
console.log("March certs to purge:", certIds);

// Fetch tip
const tipRes = d1(
    `SELECT id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json, ip_hash, user_agent, ts, prev_hash FROM audit_log ORDER BY ts DESC, id DESC LIMIT 1`);
let tip = tipRes[0].results[0];
console.log("Tip:", tip.id, tip.action, tip.ts);

const inserts = [];

function appendAudit(action, entityType, entityId, before) {
    const row = {
        id: ulid(),
        actor_type: "system",
        actor_id: "purge_test_fixtures",
        action,
        entity_type: entityType,
        entity_id: entityId,
        before_json: before == null ? null : JSON.stringify(before),
        after_json: null,
        ip_hash: null,
        user_agent: null,
        ts: new Date().toISOString(),
        prev_hash: sha(canonicalAuditRow(tip)),
    };
    tip = row;
    inserts.push(
        `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json, ip_hash, user_agent, ts, prev_hash) VALUES (${sqlEsc(row.id)}, ${sqlEsc(row.actor_type)}, ${sqlEsc(row.actor_id)}, ${sqlEsc(row.action)}, ${sqlEsc(row.entity_type)}, ${sqlEsc(row.entity_id)}, ${sqlEsc(row.before_json)}, NULL, NULL, NULL, ${sqlEsc(row.ts)}, ${sqlEsc(row.prev_hash)});`,
    );
}

for (const cid of certIds) {
    appendAudit("test_fixture_cert_purged", "cert", cid, { period_yyyymm: "202603", reason: "seeded test data, not a real issuance" });
}
appendAudit("test_fixture_attendance_purged", "attendance", `${TEST_USER}:${TEST_STREAM}`, { user_id: TEST_USER, stream_id: TEST_STREAM, first_msg_id: "TESTMSG001" });
appendAudit("test_fixture_stream_purged", "stream", TEST_STREAM, { title: null, yt_video_id: "TEST", scheduled_date: "2026-03-02" });

const deletes = [
    ...certIds.map(id => `DELETE FROM certs WHERE id='${id}';`),
    `DELETE FROM attendance WHERE user_id='${TEST_USER}' AND stream_id='${TEST_STREAM}';`,
    `DELETE FROM streams WHERE id='${TEST_STREAM}';`,
];

const sql = [...inserts, ...deletes].join("\n");
const path = "/tmp/purge_test_fixtures.sql";
writeFileSync(path, sql + "\n");
console.log("Wrote", inserts.length, "audit inserts +", deletes.length, "deletes to", path);

// Execute
execFileSync("wrangler",
    ["d1", "execute", "sc-cpe", "--remote", `--file=${path}`],
    { stdio: "inherit", cwd: "pages" });

unlinkSync(path);
console.log("Done.");
