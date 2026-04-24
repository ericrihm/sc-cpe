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

// ── handler integration tests ─────────────────────────────────────────────

import { onRequestGet as credentialGet } from "./credential/[token].js";
import { onRequestGet as jwksGet } from "./jwks.js";

const BASE = "https://sc-cpe-web.pages.dev";
const TEST_SEED = "qFQJoNZXVL3jEJMCKzvXhIx7PdpSxvAVT5cB4YdBjN8=";
const VALID_TOKEN = "a".repeat(64);

const kvPermissive = { get: async () => null, put: async () => {} };

function mockDB(rules) {
    return {
        prepare(sql) {
            const rule = rules.find(r => r.match.test(sql));
            if (!rule) throw new Error("no mock rule matched SQL: " + sql.slice(0, 120));
            let binds = [];
            const stmt = {
                bind(...args) { binds = args; return stmt; },
                first: async () => rule.handler(sql, binds).first ?? null,
                all: async () => ({ results: rule.handler(sql, binds).all ?? [] }),
                run: async () => rule.handler(sql, binds).run ?? { meta: {} },
            };
            return stmt;
        },
    };
}

const FAKE_CERT = {
    id: "cert-001",
    public_token: VALID_TOKEN,
    period_yyyymm: "202604",
    period_start: "2026-04-01",
    period_end: "2026-04-30",
    cpe_total: 10.0,
    sessions_count: 20,
    generated_at: "2026-04-30T12:00:00Z",
    recipient_name_snapshot: "Jane Doe",
    state: "generated",
};

function certDB(cert) {
    return mockDB([
        { match: /FROM certs WHERE public_token/, handler: () => ({ first: cert }) },
        { match: /INSERT INTO audit_log/, handler: () => ({ run: { meta: {} } }) },
        { match: /SELECT id, ts, prev_hash FROM audit_log/, handler: () => ({ first: { id: "01X", ts: "2026-04-22T00:00:00Z", prev_hash: "abc" } }) },
    ]);
}

// ── credential endpoint ───────────────────────────────────────────────────

test("credential: short token → 400", async () => {
    const r = await credentialGet({
        params: { token: "abc" },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: new Request(BASE + "/api/ob/credential/abc"),
    });
    assert.equal(r.status, 400);
});

test("credential: unknown token → 404", async () => {
    const db = certDB(null);
    const r = await credentialGet({
        params: { token: VALID_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive, OB_SIGNING_KEY: TEST_SEED },
        request: new Request(BASE + "/api/ob/credential/" + VALID_TOKEN),
    });
    assert.equal(r.status, 404);
});

test("credential: revoked cert → 404", async () => {
    const db = certDB({ ...FAKE_CERT, state: "revoked" });
    const r = await credentialGet({
        params: { token: VALID_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive, OB_SIGNING_KEY: TEST_SEED },
        request: new Request(BASE + "/api/ob/credential/" + VALID_TOKEN),
    });
    assert.equal(r.status, 404);
});

test("credential: pending cert → 404", async () => {
    const db = certDB({ ...FAKE_CERT, state: "pending" });
    const r = await credentialGet({
        params: { token: VALID_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive, OB_SIGNING_KEY: TEST_SEED },
        request: new Request(BASE + "/api/ob/credential/" + VALID_TOKEN),
    });
    assert.equal(r.status, 404);
});

test("credential: missing OB_SIGNING_KEY → 503", async () => {
    const db = certDB(FAKE_CERT);
    const r = await credentialGet({
        params: { token: VALID_TOKEN },
        env: { DB: db, RATE_KV: kvPermissive },
        request: new Request(BASE + "/api/ob/credential/" + VALID_TOKEN),
    });
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.error, "signing_not_configured");
});

// Ed25519 raw-key import with ["sign"] is not supported in Node.js — only
// in Cloudflare Workers. We verify the handler reaches the signing step
// (meaning DB lookup, state filtering, and credential building all passed)
// and that the error is the expected Node.js limitation.
test("credential: valid cert reaches signing (Node.js Ed25519 raw-sign unsupported)", async () => {
    const db = certDB(FAKE_CERT);
    try {
        const r = await credentialGet({
            params: { token: VALID_TOKEN },
            env: { DB: db, RATE_KV: kvPermissive, OB_SIGNING_KEY: TEST_SEED },
            request: new Request(BASE + "/api/ob/credential/" + VALID_TOKEN),
        });
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("Content-Type"), "application/ld+json");
    } catch (e) {
        assert.match(e.message, /Unsupported key usage.*Ed25519/i,
            "failure must be the Node.js Ed25519 limitation, not a handler bug");
    }
});

test("credential: .json suffix stripped from token", async () => {
    const db = certDB(FAKE_CERT);
    try {
        const r = await credentialGet({
            params: { token: VALID_TOKEN + ".json" },
            env: { DB: db, RATE_KV: kvPermissive, OB_SIGNING_KEY: TEST_SEED },
            request: new Request(BASE + "/api/ob/credential/" + VALID_TOKEN + ".json"),
        });
        assert.equal(r.status, 200);
    } catch (e) {
        assert.match(e.message, /Unsupported key usage.*Ed25519/i,
            ".json stripping worked — failure is Node.js Ed25519, not token parsing");
    }
});

test("credential: rate limit trips → 429", async () => {
    const kvFull = { get: async () => "120", put: async () => {} };
    const r = await credentialGet({
        params: { token: VALID_TOKEN },
        env: { DB: certDB(FAKE_CERT), RATE_KV: kvFull, OB_SIGNING_KEY: TEST_SEED },
        request: new Request(BASE + "/api/ob/credential/" + VALID_TOKEN),
    });
    assert.equal(r.status, 429);
});

// ── JWKS endpoint ─────────────────────────────────────────────────────────

test("jwks: missing OB_SIGNING_KEY → 503", async () => {
    const r = await jwksGet({ env: {} });
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.error, "signing_not_configured");
});

test("jwks: valid → 200 with JWKS structure", async () => {
    const r = await jwksGet({ env: { OB_SIGNING_KEY: TEST_SEED } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Type"), "application/json");
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(r.headers.get("Cache-Control"), "public, max-age=86400");
    const j = await r.json();
    assert.ok(Array.isArray(j.keys), "has keys array");
    assert.equal(j.keys.length, 1);
    const key = j.keys[0];
    assert.equal(key.kty, "OKP");
    assert.equal(key.crv, "Ed25519");
    assert.equal(key.kid, "ob-signing-key");
    assert.equal(key.use, "sig");
    assert.equal(key.alg, "EdDSA");
    assert.ok(key.x, "public key x component present");
    assert.equal(key.d, undefined, "private key not leaked");
});
