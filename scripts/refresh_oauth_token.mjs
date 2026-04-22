#!/usr/bin/env node
// Quick OAuth refresh: gets a new refresh token and stores it on the poller worker.
import { createServer } from "http";
import { execFileSync } from "child_process";

const CLIENT_ID = process.env.YOUTUBE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("Set YOUTUBE_OAUTH_CLIENT_ID and YOUTUBE_OAUTH_CLIENT_SECRET env vars first.");
    process.exit(1);
}
const REDIRECT_URI = "http://localhost:3000/callback";

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/youtube.readonly");
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

const server = createServer(async (req, res) => {
    if (!req.url.startsWith("/callback")) { res.writeHead(404); res.end(); return; }
    const code = new URL(req.url, "http://localhost:3000").searchParams.get("code");
    if (!code) { res.writeHead(400); res.end("No code"); server.close(); return; }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }),
    });
    const data = await tokenRes.json();
    if (data.error) { console.error("Token error:", data.error, data.error_description); res.writeHead(500); res.end(data.error); server.close(); process.exit(1); }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Done - close this tab</h1>");

    console.log("\nRefresh token obtained. Storing on poller worker...\n");
    try {
        execFileSync("npx", ["wrangler", "secret", "put", "YOUTUBE_OAUTH_REFRESH_TOKEN", "--name", "sc-cpe-poller"], {
            input: data.refresh_token,
            stdio: ["pipe", "inherit", "inherit"],
            shell: true,
        });
        console.log("\nDone! Refresh token stored. Poller will use it on next cron firing.");
    } catch (e) {
        console.error("Failed to store secret:", e.message);
        console.log("\nManual fallback:");
        console.log(`echo '${data.refresh_token}' | npx wrangler secret put YOUTUBE_OAUTH_REFRESH_TOKEN --name sc-cpe-poller`);
    }
    server.close();
    process.exit(0);
});

server.listen(3000, () => {
    console.log("Opening browser for OAuth consent...");
    try { execFileSync("powershell.exe", ["-Command", `Start-Process '${authUrl.toString()}'`], { stdio: "ignore" }); }
    catch { console.log(`Open manually: ${authUrl.toString()}`); }
});

setTimeout(() => { console.error("Timeout"); server.close(); process.exit(1); }, 120_000);
