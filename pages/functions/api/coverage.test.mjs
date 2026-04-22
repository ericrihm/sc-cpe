// Handler-level tests for endpoints missing coverage:
//   appeal, cert-feedback (user), annual-summary, leaderboard, links, badge
//
// Run: node --test pages/functions/api/coverage.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { onRequestPost as appealPost } from "./me/[token]/appeal.js";
import { onRequestPost as certFeedbackPost } from "./me/[token]/cert-feedback.js";
import { onRequestGet as annualSummaryGet } from "./me/[token]/annual-summary.js";
import { onRequestGet as leaderboardGet } from "./leaderboard.js";
import { onRequestGet as linksGet } from "./links.js";
import { onRequestGet as badgeGet } from "./badge/[token].js";

// ── helpers ───────────────────────────────────────────────────────────────

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

const kvPermissive = { get: async () => null, put: async () => {} };
const kvTripped = { get: async () => "999", put: async () => {} };

function req(url, { method = "POST", headers = {}, body } = {}) {
    return new Request(url, {
        method,
        headers: { Origin: new URL(url).origin, ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
}

function getReq(url) {
    return new Request(url, {
        method: "GET",
        headers: { Origin: new URL(url).origin },
    });
}

// ── appeal ───────────────────────────────────────────────────────────────

test("appeal: rejects missing Origin (CSRF)", async () => {
    const r = await appealPost({
        params: { token: "a".repeat(32) },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: new Request("https://sc-cpe-web.pages.dev/api/me/x/appeal",
            { method: "POST", body: JSON.stringify({ claimed_date: "2026-04-20" }) }),
    });
    assert.equal(r.status, 403);
});

test("appeal: rejects invalid date format", async () => {
    const r = await appealPost({
        params: { token: "a".repeat(32) },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/appeal",
            { body: { claimed_date: "not-a-date" } }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_date");
});

test("appeal: rejects future date", async () => {
    const r = await appealPost({
        params: { token: "a".repeat(32) },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/appeal",
            { body: { claimed_date: "2099-01-01" } }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "future_date");
});

test("appeal: rejects evidence over 500 chars", async () => {
    const r = await appealPost({
        params: { token: "a".repeat(32) },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/appeal",
            { body: { claimed_date: "2026-04-10", evidence_text: "x".repeat(501) } }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "evidence_too_long");
});

test("appeal: unknown token → 404", async () => {
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({ first: null }) },
    ]);
    const r = await appealPost({
        params: { token: "a".repeat(32) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/appeal",
            { body: { claimed_date: "2026-04-10" } }),
    });
    assert.equal(r.status, 404);
});

test("appeal: duplicate open appeal → 409", async () => {
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({
            first: { id: "u1", yt_channel_id: "ch1", yt_display_name_seen: "Test" },
        })},
        { match: /FROM appeals WHERE user_id.*state = 'open'/, handler: () => ({
            first: { id: "existing-appeal" },
        })},
    ]);
    const r = await appealPost({
        params: { token: "a".repeat(32) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/appeal",
            { body: { claimed_date: "2026-04-10" } }),
    });
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.error, "appeal_already_open");
});

test("appeal: already credited → 409", async () => {
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({
            first: { id: "u1", yt_channel_id: "ch1", yt_display_name_seen: "Test" },
        })},
        { match: /FROM appeals WHERE user_id/, handler: () => ({ first: null })},
        { match: /FROM attendance a JOIN streams/, handler: () => ({ first: { "1": 1 } })},
    ]);
    const r = await appealPost({
        params: { token: "a".repeat(32) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/appeal",
            { body: { claimed_date: "2026-04-10" } }),
    });
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.error, "already_credited");
});

test("appeal: valid submission → 200 with id", async () => {
    let insertedBinds = null;
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({
            first: { id: "u1", yt_channel_id: "ch1", yt_display_name_seen: "Test User" },
        })},
        { match: /FROM appeals WHERE user_id/, handler: () => ({ first: null })},
        { match: /FROM attendance a JOIN streams/, handler: () => ({ first: null })},
        { match: /FROM streams WHERE scheduled_date/, handler: () => ({ first: { id: "s1" } })},
        { match: /INSERT INTO appeals/, handler: (_s, b) => { insertedBinds = b; return { run: {} }; }},
        { match: /INSERT INTO audit_log/, handler: () => ({ run: {} })},
        { match: /SELECT.*FROM audit_log/s, handler: () => ({ first: null })},
    ]);
    const r = await appealPost({
        params: { token: "a".repeat(32) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/appeal",
            { body: { claimed_date: "2026-04-10", evidence_text: "I was there" } }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.ok);
    assert.ok(j.id, "must return appeal id");
});

test("appeal: rate limit trips → 429 (keyed on user id)", async () => {
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({
            first: { id: "u1", yt_channel_id: "ch1", yt_display_name_seen: "Test" },
        })},
    ]);
    const r = await appealPost({
        params: { token: "a".repeat(32) },
        env: { DB: db, RATE_KV: kvTripped },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/appeal",
            { body: { claimed_date: "2026-04-10" } }),
    });
    assert.equal(r.status, 429);
});

test("appeal: no stream on claimed date → 404", async () => {
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({
            first: { id: "u1", yt_channel_id: "ch1", yt_display_name_seen: "Test" },
        })},
        { match: /FROM appeals WHERE user_id/, handler: () => ({ first: null })},
        { match: /FROM attendance a JOIN streams/, handler: () => ({ first: null })},
        { match: /FROM streams WHERE scheduled_date/, handler: () => ({ first: null })},
    ]);
    const r = await appealPost({
        params: { token: "a".repeat(32) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/appeal",
            { body: { claimed_date: "2026-04-10" } }),
    });
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.equal(j.error, "no_stream_on_date");
});

// ── cert-feedback ────────────────────────────────────────────────────────

test("cert-feedback: rejects missing Origin (CSRF)", async () => {
    const r = await certFeedbackPost({
        params: { token: "a".repeat(32) },
        env: { DB: mockDB([]) },
        request: new Request("https://sc-cpe-web.pages.dev/api/me/x/cert-feedback",
            { method: "POST", body: JSON.stringify({ cert_id: "c1", rating: "ok" }) }),
    });
    assert.equal(r.status, 403);
});

test("cert-feedback: rejects invalid rating", async () => {
    const r = await certFeedbackPost({
        params: { token: "a".repeat(32) },
        env: { DB: mockDB([]) },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/cert-feedback",
            { body: { cert_id: "c1", rating: "bad" } }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_rating");
});

test("cert-feedback: rejects note over 500 chars", async () => {
    const r = await certFeedbackPost({
        params: { token: "a".repeat(32) },
        env: { DB: mockDB([]) },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/cert-feedback",
            { body: { cert_id: "c1", rating: "typo", note: "x".repeat(501) } }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "note_too_long");
});

test("cert-feedback: rejects cert_id over 40 chars", async () => {
    const r = await certFeedbackPost({
        params: { token: "a".repeat(32) },
        env: { DB: mockDB([]) },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/cert-feedback",
            { body: { cert_id: "x".repeat(41), rating: "ok" } }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_cert_id");
});

test("cert-feedback: ownership check — wrong user → 404", async () => {
    const db = mockDB([
        { match: /FROM users u.*JOIN certs c/s, handler: () => ({ first: null })},
    ]);
    const r = await certFeedbackPost({
        params: { token: "a".repeat(32) },
        env: { DB: db },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/cert-feedback",
            { body: { cert_id: "c1", rating: "typo" } }),
    });
    assert.equal(r.status, 404);
});

test("cert-feedback: valid ok rating → 200, no audit row", async () => {
    let auditWritten = false;
    const db = mockDB([
        { match: /FROM users u.*JOIN certs c/s, handler: () => ({
            first: { user_id: "u1", cert_id: "c1" },
        })},
        { match: /INSERT INTO cert_feedback/, handler: () => ({ run: {} })},
        { match: /INSERT INTO audit_log/, handler: () => { auditWritten = true; return { run: {} }; }},
    ]);
    const r = await certFeedbackPost({
        params: { token: "a".repeat(32) },
        env: { DB: db },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/cert-feedback",
            { body: { cert_id: "c1", rating: "ok" } }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.ok);
    assert.equal(auditWritten, false, "ok rating should not write audit");
});

test("cert-feedback: typo rating → 200 + audit row", async () => {
    let auditWritten = false;
    const db = mockDB([
        { match: /FROM users u.*JOIN certs c/s, handler: () => ({
            first: { user_id: "u1", cert_id: "c1" },
        })},
        { match: /INSERT INTO cert_feedback/, handler: () => ({ run: {} })},
        { match: /INSERT INTO audit_log/, handler: () => { auditWritten = true; return { run: {} }; }},
        { match: /SELECT.*FROM audit_log/s, handler: () => ({ first: null })},
    ]);
    const r = await certFeedbackPost({
        params: { token: "a".repeat(32) },
        env: { DB: db },
        request: req("https://sc-cpe-web.pages.dev/api/me/x/cert-feedback",
            { body: { cert_id: "c1", rating: "typo", note: "name misspelled" } }),
    });
    assert.equal(r.status, 200);
    assert.equal(auditWritten, true, "non-ok rating must write audit");
});

// ── annual-summary ───────────────────────────────────────────────────────

test("annual-summary: GET without Origin header still works (read-only, no CSRF risk)", async () => {
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({ first: null })},
    ]);
    const r = await annualSummaryGet({
        params: { token: "a".repeat(32) },
        env: { DB: db },
        request: new Request("https://sc-cpe-web.pages.dev/api/me/x/annual-summary?year=2026"),
    });
    assert.equal(r.status, 404);
});

test("annual-summary: rejects invalid year", async () => {
    const r = await annualSummaryGet({
        params: { token: "a".repeat(32) },
        env: { DB: mockDB([]) },
        request: getReq("https://sc-cpe-web.pages.dev/api/me/x/annual-summary?year=1999"),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "invalid_year");
});

test("annual-summary: unknown token → 404", async () => {
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({ first: null })},
    ]);
    const r = await annualSummaryGet({
        params: { token: "a".repeat(32) },
        env: { DB: db },
        request: getReq("https://sc-cpe-web.pages.dev/api/me/x/annual-summary?year=2026"),
    });
    assert.equal(r.status, 404);
});

test("annual-summary: valid request → 200 with 12 months", async () => {
    const db = mockDB([
        { match: /FROM users WHERE dashboard_token/, handler: () => ({ first: { id: "u1" } })},
        { match: /FROM attendance a\s+.*JOIN streams/s, handler: () => ({
            all: [
                { earned_cpe: 0.5, scheduled_date: "2026-03-10" },
                { earned_cpe: 0.5, scheduled_date: "2026-03-11" },
                { earned_cpe: 0.5, scheduled_date: "2026-04-01" },
            ],
        })},
        { match: /FROM certs/, handler: () => ({ all: [{ id: "c1" }] })},
    ]);
    const r = await annualSummaryGet({
        params: { token: "a".repeat(32) },
        env: { DB: db },
        request: getReq("https://sc-cpe-web.pages.dev/api/me/x/annual-summary?year=2026"),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.year, 2026);
    assert.equal(j.months.length, 12);
    assert.equal(j.total_cpe, 1.5);
    assert.equal(j.sessions_attended, 3);
    assert.equal(j.certs_issued, 1);
    assert.equal(j.months[2].cpe, 1.0, "March = 2 sessions × 0.5");
    assert.equal(j.months[3].cpe, 0.5, "April = 1 session × 0.5");
});

// ── leaderboard ──────────────────────────────────────────────────────────

test("leaderboard: returns entries with privacy-safe display names", async () => {
    const db = mockDB([
        { match: /FROM attendance/, handler: () => ({
            all: [
                { legal_name: "Alice Johnson", cpe_earned: 5, sessions: 10 },
                { legal_name: "Bob", cpe_earned: 3, sessions: 6 },
            ],
        })},
    ]);
    const r = await leaderboardGet({
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/leaderboard"),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.period);
    assert.equal(j.entries.length, 2);
    assert.equal(j.entries[0].display_name, "Alice J.");
    assert.equal(j.entries[0].rank, 1);
    assert.equal(j.entries[1].display_name, "Bob");
});

test("leaderboard: rate limit trips → 429", async () => {
    const r = await leaderboardGet({
        env: { DB: mockDB([]), RATE_KV: kvTripped },
        request: getReq("https://sc-cpe-web.pages.dev/api/leaderboard"),
    });
    assert.equal(r.status, 429);
});

// ── links ────────────────────────────────────────────────────────────────

test("links: no data → empty response", async () => {
    const db = mockDB([
        { match: /LEFT JOIN show_links/, handler: () => ({ all: [] })},
    ]);
    const r = await linksGet({
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/links"),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.date, null);
    assert.deepEqual(j.links, []);
    assert.deepEqual(j.available_dates, []);
    assert.deepEqual(j.date_link_counts, {});
});

test("links: with date param → returns links for that date", async () => {
    const db = mockDB([
        { match: /LEFT JOIN show_links/, handler: () => ({
            all: [
                { scheduled_date: "2026-04-10", cnt: 3 },
                { scheduled_date: "2026-04-09", cnt: 0 },
            ],
        })},
        { match: /FROM streams\s+WHERE scheduled_date/s, handler: () => ({
            first: { id: "s1", title: "DTB 2026-04-10", yt_video_id: "v1" },
        })},
        { match: /FROM show_links\s+WHERE stream_id/s, handler: () => ({
            all: [{ url: "https://example.com", domain: "example.com", title: "Test",
                     description: null, author_type: "owner", author_name: "SC", posted_at: "2026-04-10T10:00:00Z" }],
        })},
    ]);
    const r = await linksGet({
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/links?date=2026-04-10"),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.date, "2026-04-10");
    assert.equal(j.links.length, 1);
    assert.equal(j.links[0].url, "https://example.com");
    assert.ok(j.available_dates.length >= 1);
});

test("links: rate limit trips → 429", async () => {
    const r = await linksGet({
        env: { DB: mockDB([]), RATE_KV: kvTripped },
        request: getReq("https://sc-cpe-web.pages.dev/api/links"),
    });
    assert.equal(r.status, 429);
});

test("links: invalid date param falls back to latest", async () => {
    const db = mockDB([
        { match: /LEFT JOIN show_links/, handler: () => ({
            all: [
                { scheduled_date: "2026-04-10", cnt: 3 },
                { scheduled_date: "2026-04-09", cnt: 0 },
            ],
        })},
        { match: /FROM streams\s+WHERE scheduled_date/s, handler: () => ({
            first: { id: "s1", title: "DTB", yt_video_id: "v1" },
        })},
        { match: /FROM show_links\s+WHERE stream_id/s, handler: () => ({ all: [] })},
    ]);
    const r = await linksGet({
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/links?date=not-a-date"),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.date, "2026-04-10");
});

test("links: response includes date_link_counts object", async () => {
    const db = mockDB([
        { match: /LEFT JOIN show_links/, handler: () => ({
            all: [
                { scheduled_date: "2026-04-10", cnt: 5 },
                { scheduled_date: "2026-04-09", cnt: 2 },
                { scheduled_date: "2026-04-08", cnt: 0 },
            ],
        })},
        { match: /FROM streams\s+WHERE scheduled_date/s, handler: () => ({
            first: { id: "s1", title: "DTB 2026-04-10", yt_video_id: "v1" },
        })},
        { match: /FROM show_links\s+WHERE stream_id/s, handler: () => ({ all: [] })},
    ]);
    const r = await linksGet({
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/links"),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(typeof j.date_link_counts, "object");
    assert.equal(j.date_link_counts["2026-04-10"], 5);
    assert.equal(j.date_link_counts["2026-04-09"], 2);
    assert.equal(j.date_link_counts["2026-04-08"], 0);
});

test("links: empty show day — stream exists, no links", async () => {
    const db = mockDB([
        { match: /LEFT JOIN show_links/, handler: () => ({
            all: [
                { scheduled_date: "2026-04-10", cnt: 3 },
                { scheduled_date: "2026-04-09", cnt: 0 },
            ],
        })},
        { match: /FROM streams\s+WHERE scheduled_date/s, handler: () => ({
            first: { id: "s2", title: "DTB 2026-04-09", yt_video_id: "v2" },
        })},
        { match: /FROM show_links\s+WHERE stream_id/s, handler: () => ({ all: [] })},
    ]);
    const r = await linksGet({
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/links?date=2026-04-09"),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.date, "2026-04-09");
    assert.ok(j.stream, "stream info should be present");
    assert.equal(j.stream.title, "DTB 2026-04-09");
    assert.deepEqual(j.links, []);
});

test("links: viewer links excluded from response", async () => {
    let showLinksSql = null;
    const db = mockDB([
        { match: /LEFT JOIN show_links/, handler: () => ({
            all: [{ scheduled_date: "2026-04-10", cnt: 1 }],
        })},
        { match: /FROM streams\s+WHERE scheduled_date/s, handler: () => ({
            first: { id: "s1", title: "DTB", yt_video_id: "v1" },
        })},
        { match: /FROM show_links\s+WHERE stream_id/s, handler: (sql) => {
            showLinksSql = sql;
            return { all: [] };
        }},
    ]);
    await linksGet({
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/links?date=2026-04-10"),
    });
    assert.ok(showLinksSql, "show_links query must have been executed");
    assert.ok(/author_type IN/.test(showLinksSql), "show_links query must filter by author_type");
});

// ── badge ────────────────────────────────────────────────────────────────

test("badge: short token → 400", async () => {
    const r = await badgeGet({
        params: { token: "short" },
        env: { DB: mockDB([]), RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/badge/short"),
    });
    assert.equal(r.status, 400);
});

test("badge: unknown token → 404", async () => {
    const db = mockDB([
        { match: /FROM users WHERE badge_token/, handler: () => ({ first: null })},
    ]);
    const r = await badgeGet({
        params: { token: "a".repeat(32) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/badge/" + "a".repeat(32)),
    });
    assert.equal(r.status, 404);
});

test("badge: valid user → SVG with correct content type", async () => {
    const db = mockDB([
        { match: /FROM users WHERE badge_token/, handler: () => ({
            first: { id: "u1", legal_name: "Alice Test", state: "active" },
        })},
        { match: /FROM attendance a JOIN streams/, handler: () => ({
            all: [
                { earned_cpe: 0.5, scheduled_date: "2026-04-10" },
                { earned_cpe: 0.5, scheduled_date: "2026-04-09" },
            ],
        })},
    ]);
    const r = await badgeGet({
        params: { token: "a".repeat(32) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/badge/" + "a".repeat(32)),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Type"), "image/svg+xml");
    const svg = await r.text();
    assert.ok(svg.includes("<svg"), "must be SVG");
    assert.ok(svg.includes("Alice"), "must include first name");
    assert.ok(svg.includes("1.0"), "must include total CPE");
});

test("badge: XSS in legal_name is escaped in SVG", async () => {
    const db = mockDB([
        { match: /FROM users WHERE badge_token/, handler: () => ({
            first: { id: "u1", legal_name: '<script>alert("xss")</script>', state: "active" },
        })},
        { match: /FROM attendance a JOIN streams/, handler: () => ({ all: [] })},
    ]);
    const r = await badgeGet({
        params: { token: "a".repeat(32) },
        env: { DB: db, RATE_KV: kvPermissive },
        request: getReq("https://sc-cpe-web.pages.dev/api/badge/" + "a".repeat(32)),
    });
    assert.equal(r.status, 200);
    const svg = await r.text();
    assert.ok(!svg.includes("<script>"), "script tags must be escaped");
    assert.ok(svg.includes("&lt;script&gt;"), "angle brackets must be entity-encoded");
});

test("badge: rate limit trips → rate limited response", async () => {
    const r = await badgeGet({
        params: { token: "a".repeat(32) },
        env: { DB: mockDB([]), RATE_KV: kvTripped },
        request: getReq("https://sc-cpe-web.pages.dev/api/badge/" + "a".repeat(32)),
    });
    assert.equal(r.status, 429);
});
