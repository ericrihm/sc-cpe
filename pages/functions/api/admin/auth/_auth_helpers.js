const enc = new TextEncoder();
const dec = new TextDecoder();

export function base64url(str) {
    const bytes = enc.encode(str);
    const binStr = String.fromCharCode(...bytes);
    return btoa(binStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function debase64url(b64) {
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    const binStr = atob(padded);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    return dec.decode(bytes);
}

async function hmacSign(payload, secret) {
    const key = await crypto.subtle.importKey(
        "raw", enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
    return base64url(String.fromCharCode(...sig));
}

async function hmacVerify(payload, signature, secret) {
    const expected = await hmacSign(payload, secret);
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
}

export async function signPayload(payload, secret) {
    const b64 = base64url(payload);
    const sig = await hmacSign(b64, secret);
    return b64 + "." + sig;
}

export async function verifyPayload(signed, secret) {
    const dot = signed.lastIndexOf(".");
    if (dot < 1) return null;
    const b64 = signed.slice(0, dot);
    const sig = signed.slice(dot + 1);
    if (!(await hmacVerify(b64, sig, secret))) return null;
    try { return debase64url(b64); } catch { return null; }
}

export async function buildMagicLinkToken(email, expires, nonce, secret) {
    const payload = email + "." + expires + "." + nonce;
    return signPayload(payload, secret);
}

export async function parseMagicLinkToken(token, secret) {
    const raw = await verifyPayload(token, secret);
    if (!raw) return null;
    const parts = raw.split(".");
    if (parts.length < 3) return null;
    const nonce = parts.pop();
    const expires = parseInt(parts.pop(), 10);
    const email = parts.join(".");
    if (!Number.isFinite(expires) || expires < Date.now()) return null;
    return { email, expires, nonce };
}

export async function buildSessionCookie(email, expires, secret) {
    const payload = email + "." + expires;
    return signPayload(payload, secret);
}

export async function parseSessionCookie(cookie, secret) {
    const raw = await verifyPayload(cookie, secret);
    if (!raw) return null;
    const dot = raw.lastIndexOf(".");
    if (dot < 1) return null;
    const email = raw.slice(0, dot);
    const expires = parseInt(raw.slice(dot + 1), 10);
    if (!Number.isFinite(expires) || expires < Date.now()) return null;
    return { email, expires };
}

export function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    for (const pair of cookieHeader.split(";")) {
        const eq = pair.indexOf("=");
        if (eq < 1) continue;
        cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    return cookies;
}

export const COOKIE_NAME = "__Host-sc-admin";
export const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
export const MAGIC_LINK_MAX_AGE = 15 * 60 * 1000;

export function sessionCookieHeader(value, maxAge = 86400) {
    return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
