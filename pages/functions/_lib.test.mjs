// Unit tests for pure helpers in _lib.js. These guard the 12-fix hardening
// bundle: isSameOrigin (CSRF), escapeLike (LIKE-injection), and the input
// validators used at registration / admin-search entry points.
//
// Run: node --test pages/functions/_lib.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    isSameOrigin, escapeLike, isValidEmail, isValidName, isValidToken,
} from "./_lib.js";

function req(url, headers = {}) {
    return new Request(url, { headers });
}

test("isSameOrigin: missing Origin header → false", () => {
    assert.equal(isSameOrigin(req("https://sc-cpe.pages.dev/api/x"), {}), false);
});

test("isSameOrigin: matching Origin → true", () => {
    const r = req("https://sc-cpe.pages.dev/api/x",
        { Origin: "https://sc-cpe.pages.dev" });
    assert.equal(isSameOrigin(r, {}), true);
});

test("isSameOrigin: cross-origin Origin → false", () => {
    const r = req("https://sc-cpe.pages.dev/api/x",
        { Origin: "https://evil.example" });
    assert.equal(isSameOrigin(r, {}), false);
});

test("isSameOrigin: ALLOWED_ORIGINS allow-list admits listed origin", () => {
    const r = req("https://sc-cpe.pages.dev/api/x",
        { Origin: "https://preview.sc-cpe.pages.dev" });
    assert.equal(
        isSameOrigin(r, { ALLOWED_ORIGINS: "https://preview.sc-cpe.pages.dev" }),
        true,
    );
});

test("isSameOrigin: allow-list doesn't leak into other origins", () => {
    const r = req("https://sc-cpe.pages.dev/api/x",
        { Origin: "https://evil.example" });
    assert.equal(
        isSameOrigin(r, { ALLOWED_ORIGINS: "https://preview.sc-cpe.pages.dev" }),
        false,
    );
});

test("escapeLike: % and _ and \\ are neutralised", () => {
    // Attacker input `_` would match any single char; after escaping it
    // collapses to a literal underscore in `LIKE ?1 ESCAPE '\'`.
    assert.equal(escapeLike("_"), "\\_");
    assert.equal(escapeLike("%"), "\\%");
    assert.equal(escapeLike("\\"), "\\\\");
    assert.equal(escapeLike("a%b_c\\d"), "a\\%b\\_c\\\\d");
});

test("escapeLike: benign input is unchanged", () => {
    assert.equal(escapeLike("alice@example.com"), "alice@example.com");
    assert.equal(escapeLike(""), "");
});

test("escapeLike: coerces non-string input safely", () => {
    assert.equal(escapeLike(42), "42");
    assert.equal(escapeLike(null), "null");
});

test("isValidEmail: happy path", () => {
    assert.equal(isValidEmail("alice@example.com"), true);
});

test("isValidEmail: rejects empties and garbage", () => {
    assert.equal(isValidEmail(""), false);
    assert.equal(isValidEmail(null), false);
    assert.equal(isValidEmail("no-at-sign"), false);
    assert.equal(isValidEmail("a@b"), false);  // no TLD
    assert.equal(isValidEmail("a @b.c"), false);  // whitespace
});

test("isValidEmail: bounds at 254 chars", () => {
    // Local-part + "@ex.co" (6 chars) → 254 total needs local=248.
    const ok = "a".repeat(248) + "@ex.co";         // 254 chars, allowed
    const tooLong = "a".repeat(249) + "@ex.co";    // 255 chars, rejected
    assert.equal(ok.length, 254);
    assert.equal(tooLong.length, 255);
    assert.equal(isValidEmail(ok), true);
    assert.equal(isValidEmail(tooLong), false);
});

test("isValidName: happy path", () => {
    assert.equal(isValidName("Alice Rihm"), true);
    assert.equal(isValidName("Jean-Luc Picard"), true);
    assert.equal(isValidName("李雷"), true);  // non-latin letters
});

test("isValidName: rejects length extremes", () => {
    assert.equal(isValidName("A"), false);        // too short
    assert.equal(isValidName("A".repeat(101)), false); // too long
});

test("isValidName: rejects control chars / zero-width / BOM", () => {
    // A zero-width joiner snuck into a name could cause display-name spoofing
    // on the certificate PDF.
    assert.equal(isValidName("Al\u200Dice"), false);  // ZWJ
    assert.equal(isValidName("Al\u0000ice"), false);  // NUL
    assert.equal(isValidName("Al\uFEFFice"), false);  // BOM
});

test("isValidName: requires at least one letter", () => {
    assert.equal(isValidName("1234567"), false);
    assert.equal(isValidName("-- --"), false);
});

test("isValidToken: accepts 64-char lowercase hex", () => {
    assert.equal(isValidToken("a".repeat(64)), true);
    assert.equal(isValidToken("0123456789abcdef".repeat(4)), true);
});

test("isValidToken: rejects wrong length", () => {
    assert.equal(isValidToken("a".repeat(63)), false);
    assert.equal(isValidToken("a".repeat(65)), false);
    assert.equal(isValidToken(""), false);
});

test("isValidToken: rejects uppercase and non-hex chars", () => {
    assert.equal(isValidToken("A".repeat(64)), false);
    assert.equal(isValidToken("g" + "a".repeat(63)), false);
    assert.equal(isValidToken("!" + "a".repeat(63)), false);
});

test("isValidToken: rejects non-string input", () => {
    assert.equal(isValidToken(null), false);
    assert.equal(isValidToken(undefined), false);
    assert.equal(isValidToken(42), false);
});
