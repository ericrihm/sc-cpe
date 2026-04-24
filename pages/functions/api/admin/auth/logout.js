import { json } from "../../../_lib.js";
import { sessionCookieHeader } from "./_auth_helpers.js";

export async function onRequestPost() {
    return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Set-Cookie": sessionCookieHeader("deleted", 0),
        },
    });
}
