#!/usr/bin/env node
// Fully automated YouTube OAuth token setup for SC-CPE poller.
//
// Prerequisites:
//   - Add http://localhost:3000/callback as a redirect URI in your
//     Google Cloud Console OAuth client config (one-time).
//
// Usage:
//   node scripts/get_oauth_token.mjs path/to/client_secret_*.json
//
// What happens:
//   1. Starts a local HTTP server on port 3000
//   2. Opens your browser to Google's consent screen
//   3. You sign in and approve (the only manual step)
//   4. Google redirects to localhost — script catches the code
//   5. Exchanges code for a long-lived refresh token
//   6. Stores secrets in Cloudflare via wrangler
//   7. Done.

import { readFileSync } from "fs";
import { createServer } from "http";
import { execSync } from "child_process";

const jsonPath = process.argv[2];
if (!jsonPath) {
    console.error("Usage: node scripts/get_oauth_token.mjs <client_secret.json>");
    process.exit(1);
}

const creds = JSON.parse(readFileSync(jsonPath, "utf8"));
const { client_id, client_secret } = creds.web || creds.installed;
const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", client_id);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPE);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log("\n=== SC-CPE YouTube OAuth Setup ===\n");
console.log("Starting local server on port 3000...");

const server = createServer(async (req, res) => {
    if (!req.url.startsWith("/callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
    }

    const url = new URL(req.url, "http://localhost:3000");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Error: ${error}</h1><p>Close this tab and try again.</p>`);
        console.error(`\nGoogle returned error: ${error}`);
        server.close();
        process.exit(1);
    }

    if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>No code received</h1><p>Close this tab and try again.</p>`);
        return;
    }

    console.log("Authorization code received. Exchanging for tokens...");

    try {
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                code,
                client_id,
                client_secret,
                redirect_uri: REDIRECT_URI,
                grant_type: "authorization_code",
            }),
        });

        const data = await tokenRes.json();

        if (data.error) {
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end(`<h1>Token exchange failed</h1><p>${data.error}: ${data.error_description}</p>`);
            console.error(`\nToken exchange failed: ${data.error} — ${data.error_description}`);
            server.close();
            process.exit(1);
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
            <html><body style="font-family:system-ui;max-width:600px;margin:40px auto;text-align:center">
            <h1 style="color:#10b981">&#x2705; OAuth Setup Complete</h1>
            <p>Refresh token obtained. Secrets are being stored in Cloudflare.</p>
            <p style="color:#666">You can close this tab.</p>
            </body></html>
        `);

        console.log("\n=== TOKEN EXCHANGE SUCCESSFUL ===\n");
        console.log(`Refresh Token: ${data.refresh_token}`);
        console.log(`Access Token:  ${data.access_token?.slice(0, 30)}...`);
        console.log(`Expires In:    ${data.expires_in}s\n`);

        // Store secrets via wrangler
        console.log("Storing secrets in Cloudflare Workers...\n");
        const pollerDir = new URL("../workers/poller", import.meta.url).pathname;

        const secrets = [
            ["YOUTUBE_OAUTH_CLIENT_ID", client_id],
            ["YOUTUBE_OAUTH_CLIENT_SECRET", client_secret],
            ["YOUTUBE_OAUTH_REFRESH_TOKEN", data.refresh_token],
        ];

        for (const [name, value] of secrets) {
            try {
                execSync(`echo '${value}' | npx wrangler secret put ${name}`, {
                    cwd: pollerDir,
                    stdio: ["pipe", "pipe", "pipe"],
                });
                console.log(`  ✓ ${name} stored`);
            } catch (err) {
                console.error(`  ✗ ${name} failed: ${err.message}`);
                console.log(`    Manual fallback: cd workers/poller && echo '${value}' | wrangler secret put ${name}`);
            }
        }

        console.log("\n=== DONE ===");
        console.log("Next: deploy the updated poller code that uses OAuth for liveChatMessages.\n");

    } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<h1>Error</h1><p>${err.message}</p>`);
        console.error(`\nFetch error: ${err.message}`);
    }

    server.close();
    setTimeout(() => process.exit(0), 1000);
});

server.listen(3000, () => {
    console.log("Server listening on http://localhost:3000/callback");
    console.log("\nOpening browser for Google sign-in...\n");

    // Open browser on Windows from WSL
    try {
        execSync(`cmd.exe /c start "" "${authUrl.toString()}"`, { stdio: "ignore" });
    } catch {
        // Fallback for non-WSL or Linux with xdg-open
        try {
            execSync(`xdg-open "${authUrl.toString()}"`, { stdio: "ignore" });
        } catch {
            console.log("Could not open browser automatically. Open this URL manually:\n");
            console.log(`  ${authUrl.toString()}\n`);
        }
    }

    console.log("Waiting for you to sign in and approve access...");
    console.log("(The browser should have opened automatically)\n");
});

// Timeout after 5 minutes
setTimeout(() => {
    console.error("\nTimed out waiting for OAuth callback. Try again.");
    server.close();
    process.exit(1);
}, 300_000);
