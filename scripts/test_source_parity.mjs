// Source-level parity tests for duplicated logic across deploy boundaries.
// These read the actual source files and assert the critical sections match,
// catching drift that would otherwise be invisible until production breaks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
    return readFileSync(resolve(ROOT, rel), "utf8");
}

function extractFunction(src, name) {
    const re = new RegExp(`^(?:export )?function ${name}\\(`, "m");
    const start = src.search(re);
    if (start === -1) throw new Error(`${name} not found`);
    let depth = 0, i = src.indexOf("{", start);
    for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        if (src[i] === "}") depth--;
        if (depth === 0) break;
    }
    const body = src.slice(start, i + 1);
    return body
        .replace(/^export /, "")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function extractObject(src, name) {
    const re = new RegExp(`(?:export )?const ${name}\\s*=\\s*\\{`, "m");
    const start = src.search(re);
    if (start === -1) throw new Error(`${name} not found`);
    let depth = 0, i = src.indexOf("{", start);
    for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        if (src[i] === "}") depth--;
        if (depth === 0) break;
    }
    const body = src.slice(src.indexOf("{", start), i + 1);
    return body.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

// --- canonicalAuditRow parity ---

const CANONICAL_SOURCES = [
    "pages/functions/_lib.js",
    "workers/poller/src/index.js",
    "workers/purge/src/index.js",
];

test("canonicalAuditRow is identical across all JS sources", () => {
    const bodies = CANONICAL_SOURCES.map(rel => {
        const src = read(rel);
        return { rel, body: extractFunction(src, "canonicalAuditRow") };
    });
    const reference = bodies[0];
    for (const other of bodies.slice(1)) {
        assert.equal(other.body, reference.body,
            `canonicalAuditRow drift: ${other.rel} differs from ${reference.rel}`);
    }
});

// --- EXPECTED_CADENCE_S parity ---

test("EXPECTED_CADENCE_S matches between _heartbeat.js and purge worker", () => {
    const heartbeat = read("pages/functions/_heartbeat.js");
    const purge = read("workers/purge/src/index.js");
    const a = extractObject(heartbeat, "EXPECTED_CADENCE_S");
    const b = extractObject(purge, "EXPECTED_CADENCE_S");
    assert.equal(a, b,
        "EXPECTED_CADENCE_S drift between _heartbeat.js and purge worker");
});
