export async function onRequestPost({ request, env }) {
    let report;
    try { report = await request.json(); }
    catch { return new Response(null, { status: 204 }); }

    const violation = report?.["csp-report"] || report;
    const entry = {
        blocked: violation?.["blocked-uri"] || violation?.blockedURL || "?",
        directive: violation?.["violated-directive"] || violation?.effectiveDirective || "?",
        document: violation?.["document-uri"] || violation?.documentURL || "?",
        ts: new Date().toISOString(),
    };

    if (env.RATE_KV) {
        const bucket = entry.ts.slice(0, 13);
        const key = `sec:csp_violation:${bucket}`;
        const cur = parseInt(await env.RATE_KV.get(key), 10) || 0;
        await env.RATE_KV.put(key, String(cur + 1), { expirationTtl: 86400 });

        const logKey = `csp_log:${bucket}:${cur}`;
        if (cur < 50) {
            await env.RATE_KV.put(logKey, JSON.stringify(entry), { expirationTtl: 86400 });
        }
    }

    console.log("csp-violation", JSON.stringify(entry));
    return new Response(null, { status: 204 });
}
