// Unit tests for the race-detection helper. Run with:
//   node --test workers/poller/src/race-detection.test.mjs
//
// No framework deps — uses node's built-in test runner (node 20+).

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectContestedCodes } from "./index.js";

function msg(code, channelId) {
    return {
        snippet: { displayMessage: `random chatter SC-CPE-${code} more text` },
        authorDetails: { channelId },
    };
}

test("single channel posting its code → not contested", () => {
    const items = [msg("ABCDEFGH", "UC_user_1")];
    const contested = detectContestedCodes(items);
    assert.equal(contested.size, 0);
});

test("two channels posting the same code → contested", () => {
    const items = [
        msg("ABCDEFGH", "UC_user_1"),
        msg("ABCDEFGH", "UC_attacker"),
    ];
    const contested = detectContestedCodes(items);
    assert.ok(contested.has("ABCDEFGH"), "code should be marked contested");
});

test("case-insensitive detection (attacker lowercases)", () => {
    const items = [
        { snippet: { displayMessage: "SC-CPE-ABCDEFGH" },
          authorDetails: { channelId: "UC_a" } },
        { snippet: { displayMessage: "sc-cpe-abcdefgh" },
          authorDetails: { channelId: "UC_b" } },
    ];
    const contested = detectContestedCodes(items);
    assert.ok(contested.has("ABCDEFGH"));
});

test("same channel posting twice → not contested (legit retype)", () => {
    const items = [
        msg("ABCDEFGH", "UC_user_1"),
        msg("ABCDEFGH", "UC_user_1"),
    ];
    const contested = detectContestedCodes(items);
    assert.equal(contested.size, 0);
});

test("mixed batch: one contested, one clean", () => {
    const items = [
        msg("AAAAAAAA", "UC_victim"),
        msg("AAAAAAAA", "UC_attacker"),
        msg("BBBBBBBB", "UC_other_user"),
    ];
    const contested = detectContestedCodes(items);
    assert.ok(contested.has("AAAAAAAA"));
    assert.ok(!contested.has("BBBBBBBB"));
});

test("missing channelId is ignored (no phantom collisions)", () => {
    const items = [
        msg("ABCDEFGH", "UC_user_1"),
        { snippet: { displayMessage: "SC-CPE-ABCDEFGH" }, authorDetails: {} },
    ];
    const contested = detectContestedCodes(items);
    assert.equal(contested.size, 0);
});

test("non-matching text is skipped", () => {
    const items = [
        { snippet: { displayMessage: "hello world" },
          authorDetails: { channelId: "UC_x" } },
        msg("ABCDEFGH", "UC_user_1"),
    ];
    const contested = detectContestedCodes(items);
    assert.equal(contested.size, 0);
});

test("three distinct channels on same code → still contested", () => {
    const items = [
        msg("ABCDEFGH", "UC_a"),
        msg("ABCDEFGH", "UC_b"),
        msg("ABCDEFGH", "UC_c"),
    ];
    const contested = detectContestedCodes(items);
    assert.ok(contested.has("ABCDEFGH"));
    assert.equal(contested.size, 1);
});
