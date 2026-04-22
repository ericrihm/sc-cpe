import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { webcrypto } from "node:crypto";
if (!globalThis.crypto?.subtle) {
    globalThis.crypto = webcrypto;
}

const {
    signPayload, verifyPayload,
    buildMagicLinkToken, parseMagicLinkToken,
    buildSessionCookie, parseSessionCookie,
    base64url, debase64url,
} = await import("./_auth_helpers.js");

const TEST_SECRET = "a".repeat(64);

describe("base64url", () => {
    it("round-trips arbitrary strings", () => {
        const input = "hello@example.com.1234567890.abcdef";
        assert.equal(debase64url(base64url(input)), input);
    });
    it("produces URL-safe characters (no +, /, =)", () => {
        const encoded = base64url("test+value/with=padding");
        assert.ok(!/[+/=]/.test(encoded));
    });
});

describe("signPayload / verifyPayload", () => {
    it("verifies a valid signature", async () => {
        const payload = "test@example.com.9999999999999";
        const signed = await signPayload(payload, TEST_SECRET);
        assert.ok(signed.includes("."));
        const result = await verifyPayload(signed, TEST_SECRET);
        assert.equal(result, payload);
    });
    it("rejects a tampered payload", async () => {
        const signed = await signPayload("original", TEST_SECRET);
        const parts = signed.split(".");
        parts[0] = base64url("tampered");
        const result = await verifyPayload(parts.join("."), TEST_SECRET);
        assert.equal(result, null);
    });
    it("rejects with wrong secret", async () => {
        const signed = await signPayload("payload", TEST_SECRET);
        const result = await verifyPayload(signed, "b".repeat(64));
        assert.equal(result, null);
    });
});

describe("buildMagicLinkToken / parseMagicLinkToken", () => {
    it("round-trips email + nonce with valid expiry", async () => {
        const expires = Date.now() + 15 * 60 * 1000;
        const nonce = "abc123def456";
        const token = await buildMagicLinkToken("admin@test.com", expires, nonce, TEST_SECRET);
        const result = await parseMagicLinkToken(token, TEST_SECRET);
        assert.equal(result.email, "admin@test.com");
        assert.equal(result.nonce, nonce);
        assert.equal(result.expires, expires);
    });
    it("returns null for expired token", async () => {
        const expires = Date.now() - 1000;
        const token = await buildMagicLinkToken("admin@test.com", expires, "nonce1", TEST_SECRET);
        assert.equal(await parseMagicLinkToken(token, TEST_SECRET), null);
    });
    it("returns null for tampered token", async () => {
        const token = await buildMagicLinkToken("admin@test.com", Date.now() + 60000, "n", TEST_SECRET);
        assert.equal(await parseMagicLinkToken(token + "x", TEST_SECRET), null);
    });
});

describe("buildSessionCookie / parseSessionCookie", () => {
    it("round-trips email with valid expiry", async () => {
        const expires = Date.now() + 24 * 60 * 60 * 1000;
        const cookie = await buildSessionCookie("admin@test.com", expires, TEST_SECRET);
        const result = await parseSessionCookie(cookie, TEST_SECRET);
        assert.equal(result.email, "admin@test.com");
        assert.equal(result.expires, expires);
    });
    it("returns null for expired cookie", async () => {
        const expires = Date.now() - 1;
        const cookie = await buildSessionCookie("admin@test.com", expires, TEST_SECRET);
        assert.equal(await parseSessionCookie(cookie, TEST_SECRET), null);
    });
});
