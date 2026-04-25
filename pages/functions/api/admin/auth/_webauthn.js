const enc = new TextEncoder();

function b64url(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
    const padded = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

// ── Minimal CBOR decoder (handles types needed for WebAuthn) ──────────

function decodeCBOR(buf) {
    const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let offset = 0;

    function readUint8() { return data[offset++]; }
    function readUint16() {
        const v = (data[offset] << 8) | data[offset + 1]; offset += 2; return v;
    }
    function readUint32() {
        const v = (data[offset] << 24 | data[offset+1] << 16 | data[offset+2] << 8 | data[offset+3]) >>> 0;
        offset += 4; return v;
    }
    function readBytes(n) {
        const s = data.slice(offset, offset + n); offset += n; return s;
    }

    function readLength(ai) {
        if (ai < 24) return ai;
        if (ai === 24) return readUint8();
        if (ai === 25) return readUint16();
        if (ai === 26) return readUint32();
        throw new Error("cbor: unsupported length encoding " + ai);
    }

    function decode() {
        const initial = readUint8();
        const major = initial >> 5;
        const ai = initial & 0x1f;

        if (major === 0) return readLength(ai);
        if (major === 1) return -1 - readLength(ai);
        if (major === 2) return readBytes(readLength(ai));
        if (major === 3) {
            const bytes = readBytes(readLength(ai));
            return new TextDecoder().decode(bytes);
        }
        if (major === 4) {
            const len = readLength(ai);
            const arr = [];
            for (let i = 0; i < len; i++) arr.push(decode());
            return arr;
        }
        if (major === 5) {
            const len = readLength(ai);
            const map = new Map();
            for (let i = 0; i < len; i++) {
                const k = decode();
                map.set(k, decode());
            }
            return map;
        }
        if (major === 7) {
            if (ai === 20) return false;
            if (ai === 21) return true;
            if (ai === 22) return null;
        }
        throw new Error("cbor: unsupported major type " + major + " ai " + ai);
    }
    return decode();
}

// ── WebAuthn helpers ──────────────────────────────────────────────────

export function generateChallenge() {
    return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function buildRegistrationOptions({ rpId, rpName, userName, userId, challenge, excludeCredentials }) {
    return {
        rp: { id: rpId, name: rpName },
        user: {
            id: b64url(enc.encode(userId)),
            name: userName,
            displayName: userName,
        },
        challenge,
        pubKeyCredParams: [
            { type: "public-key", alg: -7 },   // ES256
            { type: "public-key", alg: -257 },  // RS256
        ],
        authenticatorSelection: {
            residentKey: "required",
            userVerification: "preferred",
        },
        attestation: "none",
        excludeCredentials: (excludeCredentials || []).map(c => ({
            type: "public-key",
            id: c.credential_id,
            transports: c.transports ? JSON.parse(c.transports) : [],
        })),
        timeout: 300000,
    };
}

export function buildAuthenticationOptions({ rpId, challenge }) {
    return {
        rpId,
        challenge,
        userVerification: "preferred",
        timeout: 300000,
    };
}

function parseAuthData(authData) {
    const rpIdHash = authData.slice(0, 32);
    const flags = authData[32];
    const signCount = (authData[33] << 24 | authData[34] << 16 | authData[35] << 8 | authData[36]) >>> 0;
    const userPresent = !!(flags & 0x01);
    const userVerified = !!(flags & 0x04);
    const attestedData = !!(flags & 0x40);
    const result = { rpIdHash, flags, signCount, userPresent, userVerified };

    if (attestedData && authData.length > 37) {
        const aaguid = authData.slice(37, 53);
        const credIdLen = (authData[53] << 8) | authData[54];
        const credentialId = authData.slice(55, 55 + credIdLen);
        const coseKeyBytes = authData.slice(55 + credIdLen);
        result.aaguid = aaguid;
        result.credentialId = credentialId;
        result.coseKeyBytes = coseKeyBytes;
    }
    return result;
}

async function coseToPublicKey(coseBytes) {
    const coseMap = decodeCBOR(coseBytes);
    const kty = coseMap.get(1);
    const alg = coseMap.get(3);

    if (kty === 2 && alg === -7) {
        const crv = coseMap.get(-1);
        if (crv !== 1) throw new Error("unsupported curve: " + crv);
        const x = coseMap.get(-2);
        const y = coseMap.get(-3);
        const rawKey = new Uint8Array(65);
        rawKey[0] = 0x04;
        rawKey.set(x, 1);
        rawKey.set(y, 33);
        const key = await crypto.subtle.importKey(
            "raw", rawKey,
            { name: "ECDSA", namedCurve: "P-256" },
            true, ["verify"],
        );
        return { key, alg: -7, rawKey };
    }

    if (kty === 3 && alg === -257) {
        const n = coseMap.get(-1);
        const e = coseMap.get(-2);
        const jwk = {
            kty: "RSA",
            n: b64url(n),
            e: b64url(e),
            alg: "RS256",
        };
        const key = await crypto.subtle.importKey(
            "jwk", jwk,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            true, ["verify"],
        );
        return { key, alg: -257 };
    }

    throw new Error("unsupported COSE key type " + kty + " alg " + alg);
}

export async function verifyRegistration({ response, expectedChallenge, expectedOrigin, expectedRpId }) {
    const clientDataJSON = b64urlDecode(response.clientDataJSON);
    const clientData = JSON.parse(new TextDecoder().decode(clientDataJSON));

    if (clientData.type !== "webauthn.create") throw new Error("invalid clientData type");
    if (clientData.challenge !== expectedChallenge) throw new Error("challenge mismatch");
    const origin = clientData.origin;
    if (origin !== expectedOrigin) throw new Error("origin mismatch: " + origin);

    const attestationObject = decodeCBOR(b64urlDecode(response.attestationObject));
    const authData = attestationObject.get("authData");
    if (!(authData instanceof Uint8Array)) throw new Error("missing authData");

    const parsed = parseAuthData(authData);
    if (!parsed.userPresent) throw new Error("user not present");

    const rpIdHashExpected = new Uint8Array(
        await crypto.subtle.digest("SHA-256", enc.encode(expectedRpId))
    );
    if (!constantTimeEq(parsed.rpIdHash, rpIdHashExpected)) throw new Error("rpId mismatch");

    if (!parsed.credentialId || !parsed.coseKeyBytes) throw new Error("no attested credential data");

    const { key, alg, rawKey } = await coseToPublicKey(parsed.coseKeyBytes);
    const exported = await crypto.subtle.exportKey("spki", key);

    return {
        credentialId: b64url(parsed.credentialId),
        publicKey: new Uint8Array(exported),
        counter: parsed.signCount,
        transports: response.transports || [],
        backedUp: !!(parsed.flags & 0x10),
    };
}

export async function verifyAuthentication({ response, expectedChallenge, expectedOrigin, expectedRpId, credential }) {
    const clientDataJSON = b64urlDecode(response.clientDataJSON);
    const clientData = JSON.parse(new TextDecoder().decode(clientDataJSON));

    if (clientData.type !== "webauthn.get") throw new Error("invalid clientData type");
    if (clientData.challenge !== expectedChallenge) throw new Error("challenge mismatch");
    if (clientData.origin !== expectedOrigin) throw new Error("origin mismatch");

    const authDataBytes = b64urlDecode(response.authenticatorData);
    const parsed = parseAuthData(authDataBytes);
    if (!parsed.userPresent) throw new Error("user not present");

    const rpIdHashExpected = new Uint8Array(
        await crypto.subtle.digest("SHA-256", enc.encode(expectedRpId))
    );
    if (!constantTimeEq(parsed.rpIdHash, rpIdHashExpected)) throw new Error("rpId mismatch");

    if (credential.counter > 0 && parsed.signCount <= credential.counter) {
        throw new Error("counter not incremented — possible cloned authenticator");
    }

    const publicKey = await crypto.subtle.importKey(
        "spki",
        credential.publicKey instanceof Uint8Array ? credential.publicKey : new Uint8Array(credential.publicKey),
        credential.alg === -257
            ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
            : { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
    );

    const clientDataHash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", clientDataJSON)
    );
    const signedData = new Uint8Array(authDataBytes.length + clientDataHash.length);
    signedData.set(authDataBytes, 0);
    signedData.set(clientDataHash, authDataBytes.length);

    const sigBytes = b64urlDecode(response.signature);

    let sig = sigBytes;
    if (credential.alg !== -257) {
        sig = derToRaw(sigBytes);
    }

    const algorithm = credential.alg === -257
        ? { name: "RSASSA-PKCS1-v1_5" }
        : { name: "ECDSA", hash: "SHA-256" };

    const valid = await crypto.subtle.verify(algorithm, publicKey, sig, signedData);
    if (!valid) throw new Error("signature verification failed");

    return { signCount: parsed.signCount };
}

function derToRaw(der) {
    if (der[0] !== 0x30) return der;
    let offset = 2;
    if (der[1] & 0x80) offset += der[1] & 0x7f;

    function readInt() {
        if (der[offset++] !== 0x02) throw new Error("expected INTEGER");
        let len = der[offset++];
        let bytes = der.slice(offset, offset + len);
        offset += len;
        if (bytes[0] === 0 && bytes.length === 33) bytes = bytes.slice(1);
        const padded = new Uint8Array(32);
        padded.set(bytes, 32 - bytes.length);
        return padded;
    }
    const r = readInt();
    const s = readInt();
    const raw = new Uint8Array(64);
    raw.set(r, 0);
    raw.set(s, 32);
    return raw;
}

function constantTimeEq(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

export { b64url, b64urlDecode, decodeCBOR };
