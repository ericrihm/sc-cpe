import { test } from "node:test";
import assert from "node:assert/strict";

import {
    generateChallenge, buildRegistrationOptions,
    buildAuthenticationOptions, b64url, b64urlDecode, decodeCBOR,
} from "./_webauthn.js";

test("generateChallenge: returns base64url string", () => {
    const c = generateChallenge();
    assert.ok(typeof c === "string");
    assert.ok(c.length > 20);
    assert.ok(!/[+/=]/.test(c), "should not contain +, /, or =");
});

test("generateChallenge: each call is unique", () => {
    const a = generateChallenge();
    const b = generateChallenge();
    assert.notEqual(a, b);
});

test("b64url roundtrip", () => {
    const original = new Uint8Array([0, 1, 2, 255, 254, 253]);
    const encoded = b64url(original);
    const decoded = b64urlDecode(encoded);
    assert.deepEqual(decoded, original);
});

test("b64url: no unsafe chars", () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    const encoded = b64url(data);
    assert.ok(!/[+/=]/.test(encoded));
});

test("buildRegistrationOptions: correct structure", () => {
    const opts = buildRegistrationOptions({
        rpId: "example.com",
        rpName: "Test",
        userName: "user@example.com",
        userId: "123",
        challenge: "test_challenge",
        excludeCredentials: [],
    });
    assert.equal(opts.rp.id, "example.com");
    assert.equal(opts.rp.name, "Test");
    assert.equal(opts.user.name, "user@example.com");
    assert.equal(opts.challenge, "test_challenge");
    assert.equal(opts.attestation, "none");
    assert.equal(opts.authenticatorSelection.residentKey, "required");
    assert.ok(opts.pubKeyCredParams.some(p => p.alg === -7));
    assert.ok(opts.pubKeyCredParams.some(p => p.alg === -257));
});

test("buildAuthenticationOptions: correct structure", () => {
    const opts = buildAuthenticationOptions({
        rpId: "example.com",
        challenge: "test_challenge",
    });
    assert.equal(opts.rpId, "example.com");
    assert.equal(opts.challenge, "test_challenge");
    assert.equal(opts.userVerification, "preferred");
});

test("decodeCBOR: unsigned integer", () => {
    const buf = new Uint8Array([0x05]);
    assert.equal(decodeCBOR(buf), 5);
});

test("decodeCBOR: text string", () => {
    const buf = new Uint8Array([0x63, 0x66, 0x6f, 0x6f]);
    assert.equal(decodeCBOR(buf), "foo");
});

test("decodeCBOR: byte string", () => {
    const buf = new Uint8Array([0x43, 0x01, 0x02, 0x03]);
    const result = decodeCBOR(buf);
    assert.ok(result instanceof Uint8Array);
    assert.deepEqual([...result], [1, 2, 3]);
});

test("decodeCBOR: map", () => {
    // {1: 2, 3: 4}
    const buf = new Uint8Array([0xa2, 0x01, 0x02, 0x03, 0x04]);
    const result = decodeCBOR(buf);
    assert.ok(result instanceof Map);
    assert.equal(result.get(1), 2);
    assert.equal(result.get(3), 4);
});

test("decodeCBOR: array", () => {
    // [1, 2, 3]
    const buf = new Uint8Array([0x83, 0x01, 0x02, 0x03]);
    const result = decodeCBOR(buf);
    assert.ok(Array.isArray(result));
    assert.deepEqual(result, [1, 2, 3]);
});

test("decodeCBOR: negative integer", () => {
    // -1
    const buf = new Uint8Array([0x20]);
    assert.equal(decodeCBOR(buf), -1);
});

test("decodeCBOR: boolean and null", () => {
    assert.equal(decodeCBOR(new Uint8Array([0xf4])), false);
    assert.equal(decodeCBOR(new Uint8Array([0xf5])), true);
    assert.equal(decodeCBOR(new Uint8Array([0xf6])), null);
});
