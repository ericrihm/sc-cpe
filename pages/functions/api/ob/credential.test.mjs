import { test } from "node:test";
import assert from "node:assert/strict";
import { jcsCanonicalise, base58btcEncode, base58btcDecode, multibaseEncode, derivePublicJwk } from "./sign.js";

test("jcsCanonicalise: sorts keys deterministically", () => {
    const obj = { z: 1, a: 2, m: { b: 3, a: 4 } };
    const result = jcsCanonicalise(obj);
    assert.equal(result, '{"a":2,"m":{"a":4,"b":3},"z":1}');
});

test("jcsCanonicalise: handles arrays (order preserved)", () => {
    const obj = { items: [3, 1, 2], name: "test" };
    const result = jcsCanonicalise(obj);
    assert.equal(result, '{"items":[3,1,2],"name":"test"}');
});

test("jcsCanonicalise: handles null and boolean", () => {
    const result = jcsCanonicalise({ a: null, b: true, c: false });
    assert.equal(result, '{"a":null,"b":true,"c":false}');
});

test("jcsCanonicalise: excludes undefined values", () => {
    const result = jcsCanonicalise({ a: 1, b: undefined, c: 3 });
    assert.equal(result, '{"a":1,"c":3}');
});

test("base58btcEncode + base58btcDecode roundtrip", () => {
    const input = new Uint8Array([1, 2, 3, 255, 0, 128]);
    const encoded = base58btcEncode(input);
    const decoded = base58btcDecode(encoded);
    assert.deepEqual(decoded, input);
});

test("base58btcEncode: known vector", () => {
    const input = new TextEncoder().encode("Hello");
    const encoded = base58btcEncode(input);
    assert.equal(encoded, "9Ajdvzr");
});

test("base58btcEncode: leading zeros preserved", () => {
    const input = new Uint8Array([0, 0, 1]);
    const encoded = base58btcEncode(input);
    assert.ok(encoded.startsWith("11"), "leading zeros become '1' chars");
});

test("multibaseEncode: prepends 'z' prefix", () => {
    const input = new Uint8Array([1, 2, 3]);
    const result = multibaseEncode(input);
    assert.ok(result.startsWith("z"));
    assert.equal(result, "z" + base58btcEncode(input));
});

import { buildObCredential } from "./credential/[token].js";

test("buildObCredential: produces valid OBv3 structure", () => {
    const cert = {
        id: "cert-123",
        public_token: "abc".repeat(22),
        period_yyyymm: "202604",
        period_start: "2026-04-01",
        period_end: "2026-04-30",
        cpe_total: 10.0,
        sessions_count: 20,
        generated_at: "2026-04-30T12:00:00Z",
        recipient_name_snapshot: "Jane Doe",
    };
    const origin = "https://sc-cpe-web.pages.dev";
    const result = buildObCredential(cert, origin);
    assert.deepEqual(result["@context"], [
        "https://www.w3.org/ns/credentials/v2",
        "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json",
    ]);
    assert.deepEqual(result.type, ["VerifiableCredential", "OpenBadgeCredential"]);
    assert.equal(result.issuer.name, "Simply Cyber");
    assert.equal(result.validFrom, "2026-04-30T12:00:00Z");
    assert.ok(result.name.includes("April 2026"));
    assert.ok(result.credentialSubject.achievement.criteria.narrative.includes("20"));
});

test("buildObCredential: formats period_yyyymm as readable month", () => {
    const cert = {
        id: "c1", public_token: "t".repeat(64), period_yyyymm: "202601",
        period_start: "2026-01-01", period_end: "2026-01-31",
        cpe_total: 5, sessions_count: 10, generated_at: "2026-01-31T00:00:00Z",
        recipient_name_snapshot: "X",
    };
    const result = buildObCredential(cert, "https://example.com");
    assert.ok(result.name.includes("January 2026"));
});

test("derivePublicJwk: returns OKP/Ed25519 JWK", async () => {
    // Test vector: a base64-encoded 32-byte Ed25519 private key seed
    // This is a consistent seed that will always generate the same keypair
    const testSeed = "qFQJoNZXVL3jEJMCKzvXhIx7PdpSxvAVT5cB4YdBjN8=";
    const jwk = await derivePublicJwk(testSeed);
    assert.equal(jwk.kty, "OKP");
    assert.equal(jwk.crv, "Ed25519");
    assert.ok(jwk.x, "x component present");
    assert.equal(typeof jwk.x, "string", "x is a string");
    assert.equal(jwk.d, undefined, "private key not leaked");
});
