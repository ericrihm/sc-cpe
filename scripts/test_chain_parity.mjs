// Chain-parity test. Generates a synthetic audit chain entirely in JS,
// computes prev_hash for each row using the SAME canonicalAuditRow +
// sha256 the writers use, then shells out to the Python verifier with
// the chain fed via stdin and asserts it reports OK. Also runs a
// deliberately-broken chain through and asserts the verifier flags it.
//
// Guards against: canonical-form drift between JS writers and Python
// verifier. If this test passes but production chain verification fails,
// that's a real chain break (not a serialization bug).
//
// Run: node scripts/test_chain_parity.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mirror of canonicalAuditRow in pages/functions/_lib.js and
// workers/*/src/index.js. Do not refactor to share — the duplication
// is the point of this test.
function canonicalAuditRow(r) {
    return JSON.stringify([
        r.id, r.actor_type, r.actor_id ?? null, r.action,
        r.entity_type, r.entity_id,
        r.before_json ?? null, r.after_json ?? null,
        r.ip_hash ?? null, r.user_agent ?? null,
        r.ts, r.prev_hash ?? null,
    ]);
}

function sha256Hex(s) {
    return createHash("sha256").update(s, "utf8").digest("hex");
}

function buildChain(n) {
    const rows = [];
    let prev = null;
    for (let i = 0; i < n; i++) {
        const row = {
            id: `01HXXXXXXXXXXXXXXXXXXXXXX${String(i).padStart(2, "0")}`,
            actor_type: i % 2 === 0 ? "user" : "system",
            actor_id: i % 3 === 0 ? null : `actor-${i}`,
            action: `action_${i}`,
            entity_type: "test",
            entity_id: `ent-${i}`,
            before_json: i % 4 === 0 ? null : `{"v":${i - 1}}`,
            after_json: `{"v":${i}}`,
            ip_hash: null,
            user_agent: null,
            ts: new Date(Date.UTC(2026, 3, 15, 12, 0, i)).toISOString(),
            prev_hash: prev,
        };
        rows.push(row);
        prev = sha256Hex(canonicalAuditRow(row));
    }
    return rows;
}

// Minimal Python script that reads JSON rows from stdin and runs the
// same verify() the production script does — but fed in-memory rows
// instead of D1 HTTP. Keeping it inline avoids a second file to maintain.
const PY_HARNESS = `
import json, sys, pathlib
sys.path.insert(0, str(pathlib.Path(${JSON.stringify(process.cwd())}) / "scripts"))
from verify_audit_chain import verify, row_hash
rows = json.load(sys.stdin)
errors = verify(rows)
if errors:
    for e in errors:
        print(e, file=sys.stderr)
    sys.exit(1)
print("OK tip_hash=" + row_hash(rows[-1]) if rows else "OK empty")
`;

function runPython(rows) {
    const dir = mkdtempSync(join(tmpdir(), "chain-parity-"));
    const script = join(dir, "harness.py");
    writeFileSync(script, PY_HARNESS);
    const r = spawnSync("python3", [script], {
        input: JSON.stringify(rows),
        encoding: "utf8",
    });
    rmSync(dir, { recursive: true, force: true });
    return r;
}

test("JS-built chain verifies clean in Python", () => {
    const rows = buildChain(25);
    const r = runPython(rows);
    assert.equal(r.status, 0,
        `python verify failed: stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /^OK/);
});

test("Single-row (genesis only) chain verifies clean", () => {
    const rows = buildChain(1);
    const r = runPython(rows);
    assert.equal(r.status, 0,
        `python verify failed: stdout=${r.stdout} stderr=${r.stderr}`);
});

test("Tampered payload breaks chain detection", () => {
    const rows = buildChain(10);
    // Flip one character in a middle row's after_json — prev_hash of the
    // next row no longer matches what canonical(rows[i]) hashes to.
    rows[5].after_json = '{"v":999}';
    const r = runPython(rows);
    assert.equal(r.status, 1, "expected python verify to flag the tamper");
    assert.match(r.stderr, /prev_hash mismatch/);
});

test("Reordered rows are detected", () => {
    const rows = buildChain(10);
    // Swap ts of two adjacent rows so they sort in a different order.
    // Python sorts input by (ts, id) ASC inside fetch_all_rows, but verify()
    // trusts caller order — we pass rows as-built. Swap positions directly
    // to simulate a reshuffle.
    [rows[3], rows[4]] = [rows[4], rows[3]];
    const r = runPython(rows);
    assert.equal(r.status, 1, "expected verify to flag reorder");
});
