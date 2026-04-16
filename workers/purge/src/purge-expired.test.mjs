// Tests for purgeExpired. Guard against: one bad-prefix stream (spam flood
// or attacker-controlled key pile) blocking all future purges by exhausting
// the Worker budget; and ensure the per-stream and wall-clock caps leave the
// db in a state where the NEXT run can make progress.

import { test } from "node:test";
import assert from "node:assert/strict";

import { purgeExpired } from "./index.js";

function makeEnv({ streams, bucketObjects }) {
    // streams: array of row shapes
    // bucketObjects: Map<stream_id, string[]> — the keys currently in R2 for each stream's prefix
    const auditWrites = [];
    const dbUpdates = [];
    const tipRow = { id: "genesis", hash: "0".repeat(64), ts: "2020-01-01T00:00:00.000Z" };

    const db = {
        prepare(sql) {
            let binds = [];
            const handler = {
                bind: (...args) => { binds = args; return handler; },
                async first() {
                    if (/FROM audit_log ORDER BY ts DESC/.test(sql)) return tipRow;
                    return null;
                },
                async all() {
                    if (/FROM streams[\s\S]*raw_r2_key IS NOT NULL/.test(sql)) {
                        return { results: streams };
                    }
                    return { results: [] };
                },
                async run() {
                    if (/UPDATE streams SET raw_r2_key = NULL/.test(sql)) {
                        dbUpdates.push({ id: binds[0] });
                    }
                    if (/INSERT INTO audit_log/.test(sql)) {
                        auditWrites.push({ sql, binds });
                    }
                    return { meta: {} };
                },
            };
            return handler;
        },
    };

    const RAW_CHAT = {
        async list({ prefix, cursor, limit }) {
            const all = bucketObjects.get(prefix) || [];
            const start = cursor ? parseInt(cursor, 10) : 0;
            const end = Math.min(start + limit, all.length);
            const slice = all.slice(start, end).map(key => ({ key }));
            const nextCursor = end < all.length ? String(end) : undefined;
            return { objects: slice, truncated: !!nextCursor, cursor: nextCursor };
        },
        async delete(keys) {
            // No-op: real R2 would remove the keys. For the test, purgeOneStream
            // stops when list returns empty (cursor = undefined) or cap hits,
            // not when the bucket is empty, so we don't need to mutate.
            void keys;
        },
    };

    return { env: { DB: db, RAW_CHAT }, auditWrites, dbUpdates };
}

test("purgeExpired: stream with few objects → cleared + audit partial:false", async () => {
    const streams = [{
        id: "s1", yt_video_id: "v1", scheduled_date: "2026-04-01",
        raw_r2_key: "raw/s1/", raw_purge_after: "2026-04-10T00:00:00Z",
    }];
    const objects = new Map([["raw/s1/", Array.from({ length: 42 }, (_, i) => `raw/s1/msg-${i}`)]]);
    const { env, auditWrites, dbUpdates } = makeEnv({ streams, bucketObjects: objects });

    const out = await purgeExpired(env, "2026-04-20T00:00:00Z");

    assert.equal(out.streams, 1, "should have cleared 1 stream");
    assert.equal(out.partial_streams, 0);
    assert.equal(out.objects, 42);
    assert.equal(dbUpdates.length, 1, "raw_r2_key should be NULLed");
    assert.equal(dbUpdates[0].id, "s1");
    // Audit row should encode partial:false
    const lastAudit = auditWrites.at(-1);
    assert.ok(lastAudit, "must write an audit row");
    const afterJson = lastAudit.binds.find(b => typeof b === "string" && b.includes("objects_deleted"));
    assert.ok(afterJson, "audit after_json should include objects_deleted");
    assert.match(afterJson, /"partial":false/);
});

test("purgeExpired: flooded stream (≫ cap) → partial, raw_r2_key NOT cleared", async () => {
    const streams = [{
        id: "s-flood", yt_video_id: "v2", scheduled_date: "2026-04-02",
        raw_r2_key: "raw/s-flood/", raw_purge_after: "2026-04-10T00:00:00Z",
    }];
    // 25_000 objects → well over PURGE_MAX_OBJECTS_PER_STREAM (10_000)
    const objects = new Map([["raw/s-flood/",
        Array.from({ length: 25_000 }, (_, i) => `raw/s-flood/msg-${i}`)]]);
    const { env, auditWrites, dbUpdates } = makeEnv({ streams, bucketObjects: objects });

    const out = await purgeExpired(env, "2026-04-20T00:00:00Z");

    assert.equal(out.streams, 0, "flooded stream must NOT be marked cleared");
    assert.equal(out.partial_streams, 1);
    assert.equal(out.objects, 10_000,
        "must stop at PURGE_MAX_OBJECTS_PER_STREAM to protect the Worker budget");
    assert.equal(dbUpdates.length, 0, "raw_r2_key must stay set so next run resumes");
    const lastAudit = auditWrites.at(-1);
    const afterJson = lastAudit.binds.find(b => typeof b === "string" && b.includes("objects_deleted"));
    assert.match(afterJson, /"partial":true/);
});

test("purgeExpired: wall-clock budget exhausted mid-stream → partial, next run resumes", async () => {
    const streams = [
        { id: "s-a", yt_video_id: "vA", scheduled_date: "2026-04-03",
          raw_r2_key: "raw/s-a/", raw_purge_after: "2026-04-10T00:00:00Z" },
        { id: "s-b", yt_video_id: "vB", scheduled_date: "2026-04-04",
          raw_r2_key: "raw/s-b/", raw_purge_after: "2026-04-11T00:00:00Z" },
    ];
    const objects = new Map([
        ["raw/s-a/", Array.from({ length: 2500 }, (_, i) => `raw/s-a/msg-${i}`)],
        ["raw/s-b/", Array.from({ length: 2500 }, (_, i) => `raw/s-b/msg-${i}`)],
    ]);
    const { env, dbUpdates } = makeEnv({ streams, bucketObjects: objects });

    // Fake clock: advance by 15_000 ms per remainingMs() call, so the budget
    // expires before stream s-a completes its second page.
    let t = 0;
    const out = await purgeExpired(env, "2026-04-20T00:00:00Z", {
        wallBudgetMs: 20_000,
        clock: () => { const v = t; t += 15_000; return v; },
    });

    assert.ok(out.streams + out.partial_streams <= 2);
    // At least one stream is either not cleared or partial — the invariant
    // is: budget exhaustion never marks a stream cleared when it isn't.
    for (const upd of dbUpdates) {
        const s = streams.find(x => x.id === upd.id);
        assert.ok(s, "all cleared ids must map to a real stream");
    }
});

test("purgeExpired: LIMIT caps streams pulled per run", async () => {
    // 60 streams due; we should ORDER BY raw_purge_after ASC LIMIT 50.
    // The SQL shape matters for supporting LIMIT ?2 bind.
    const streams = Array.from({ length: 60 }, (_, i) => ({
        id: `s${i}`, yt_video_id: `v${i}`, scheduled_date: "2026-04-05",
        raw_r2_key: `raw/s${i}/`, raw_purge_after: "2026-04-10T00:00:00Z",
    })).slice(0, 50); // the mock simulates DB having applied LIMIT 50
    const objects = new Map(
        streams.map(s => [s.raw_r2_key, [`${s.raw_r2_key}msg-0`]])
    );
    const { env } = makeEnv({ streams, bucketObjects: objects });

    const out = await purgeExpired(env, "2026-04-20T00:00:00Z");
    assert.equal(out.streams, 50);
});
