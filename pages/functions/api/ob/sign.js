const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function jcsCanonicalise(obj) {
    if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
    if (Array.isArray(obj)) return "[" + obj.map(v => jcsCanonicalise(v)).join(",") + "]";
    const keys = Object.keys(obj).sort();
    const parts = [];
    for (const k of keys) {
        if (obj[k] === undefined) continue;
        parts.push(JSON.stringify(k) + ":" + jcsCanonicalise(obj[k]));
    }
    return "{" + parts.join(",") + "}";
}

export function base58btcEncode(bytes) {
    let num = 0n;
    for (const b of bytes) num = num * 256n + BigInt(b);
    let encoded = "";
    while (num > 0n) {
        encoded = B58_ALPHABET[Number(num % 58n)] + encoded;
        num = num / 58n;
    }
    for (const b of bytes) { if (b !== 0) break; encoded = "1" + encoded; }
    return encoded || "1";
}

export function base58btcDecode(str) {
    let num = 0n;
    for (const c of str) {
        const idx = B58_ALPHABET.indexOf(c);
        if (idx < 0) throw new Error("invalid base58 char: " + c);
        num = num * 58n + BigInt(idx);
    }
    const hex = num === 0n ? "" : num.toString(16);
    const padded = hex.length % 2 ? "0" + hex : hex;
    const dataBytes = [];
    for (let i = 0; i < padded.length; i += 2) dataBytes.push(parseInt(padded.slice(i, i + 2), 16));
    let leadingZeros = 0;
    for (const c of str) { if (c !== "1") break; leadingZeros++; }
    const result = new Uint8Array(leadingZeros + dataBytes.length);
    result.set(dataBytes, leadingZeros);
    return result;
}

export function multibaseEncode(bytes) {
    return "z" + base58btcEncode(bytes);
}

export async function signCredential(credential, privateKeyB64) {
    const keyBytes = Uint8Array.from(atob(privateKeyB64), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
        "raw", keyBytes, { name: "Ed25519" }, false, ["sign"],
    );
    const canonical = jcsCanonicalise(credential);
    const signature = new Uint8Array(
        await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(canonical)),
    );
    return multibaseEncode(signature);
}

export async function derivePublicJwk(privateKeyB64) {
    const keyBytes = Uint8Array.from(atob(privateKeyB64), c => c.charCodeAt(0));
    const keyPair = await crypto.subtle.importKey(
        "raw", keyBytes, { name: "Ed25519" }, true, [],
    );
    const jwk = await crypto.subtle.exportKey("jwk", keyPair);
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
}
