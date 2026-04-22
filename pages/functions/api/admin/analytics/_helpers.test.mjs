import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRange, groupByKey } from "./_helpers.js";

test("parseRange: default is 30d daily", () => {
    const url = new URL("https://example.com/api/admin/analytics/growth");
    const r = parseRange(url);
    assert.equal(r.range, "30d");
    assert.equal(r.granularity, "daily");
    assert.ok(r.since, "since should be set");
});

test("parseRange: 7d is daily", () => {
    const url = new URL("https://example.com/?range=7d");
    const r = parseRange(url);
    assert.equal(r.range, "7d");
    assert.equal(r.granularity, "daily");
});

test("parseRange: 90d defaults to weekly", () => {
    const url = new URL("https://example.com/?range=90d");
    const r = parseRange(url);
    assert.equal(r.range, "90d");
    assert.equal(r.granularity, "weekly");
});

test("parseRange: all has no since, defaults monthly", () => {
    const url = new URL("https://example.com/?range=all");
    const r = parseRange(url);
    assert.equal(r.range, "all");
    assert.equal(r.since, null);
    assert.equal(r.granularity, "monthly");
});

test("parseRange: invalid range falls back to 30d", () => {
    const url = new URL("https://example.com/?range=banana");
    const r = parseRange(url);
    assert.equal(r.range, "30d");
});

test("parseRange: explicit granularity override", () => {
    const url = new URL("https://example.com/?range=90d&granularity=daily");
    const r = parseRange(url);
    assert.equal(r.granularity, "daily");
});

test("groupByKey: daily uses date()", () => {
    assert.equal(groupByKey("daily"), "date({col})");
});

test("groupByKey: weekly uses strftime %W", () => {
    assert.equal(groupByKey("weekly"), "strftime('%Y-W%W', {col})");
});

test("groupByKey: monthly uses strftime %Y-%m", () => {
    assert.equal(groupByKey("monthly"), "strftime('%Y-%m', {col})");
});
