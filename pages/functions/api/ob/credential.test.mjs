import { test } from "node:test";
import assert from "node:assert/strict";
import { jcsCanonicalise, base58btcEncode, base58btcDecode, multibaseEncode } from "./sign.js";

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
