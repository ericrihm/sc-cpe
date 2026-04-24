// Unit tests for streak tracking (updateStreak + prevWeekday).
// Run: node --test workers/poller/src/streak.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { updateStreak, prevWeekday } from "./index.js";

// ── prevWeekday ────────────────────────────────────────────────────────

test("prevWeekday: Monday → previous Friday", () => {
    assert.equal(prevWeekday("2026-04-20"), "2026-04-17"); // Mon → Fri
});

test("prevWeekday: Tuesday → Monday", () => {
    assert.equal(prevWeekday("2026-04-21"), "2026-04-20");
});

test("prevWeekday: Wednesday → Tuesday", () => {
    assert.equal(prevWeekday("2026-04-22"), "2026-04-21");
});

test("prevWeekday: Friday → Thursday", () => {
    assert.equal(prevWeekday("2026-04-24"), "2026-04-23");
});

test("prevWeekday: Sunday → Friday (skips Saturday)", () => {
    assert.equal(prevWeekday("2026-04-26"), "2026-04-24"); // Sun → Fri
});

test("prevWeekday: Saturday → Friday", () => {
    assert.equal(prevWeekday("2026-04-25"), "2026-04-24"); // Sat → Fri
});

// ── updateStreak ───────────────────────────────────────────────────────

function mockDB(streamDate, userRow) {
    let updatedWith = null;
    return {
        prepare(sql) {
            let binds = [];
            const stmt = {
                bind(...args) { binds = args; return stmt; },
                first: async () => {
                    if (/FROM streams/.test(sql)) {
                        return streamDate ? { scheduled_date: streamDate } : null;
                    }
                    if (/FROM users/.test(sql)) return userRow;
                    return null;
                },
                run: async () => {
                    updatedWith = { streak: binds[0], longest: binds[1], date: binds[2] };
                },
            };
            return stmt;
        },
        getUpdate() { return updatedWith; },
    };
}

test("updateStreak: first attendance → streak = 1", async () => {
    const db = mockDB("2026-04-24", {
        current_streak: 0, longest_streak: 0, last_attendance_date: null,
    });
    await updateStreak({ DB: db }, "u1", "s1");
    const u = db.getUpdate();
    assert.equal(u.streak, 1);
    assert.equal(u.longest, 1);
    assert.equal(u.date, "2026-04-24");
});

test("updateStreak: consecutive weekday → streak increments", async () => {
    const db = mockDB("2026-04-24", {
        current_streak: 3, longest_streak: 5, last_attendance_date: "2026-04-23",
    });
    await updateStreak({ DB: db }, "u1", "s1");
    const u = db.getUpdate();
    assert.equal(u.streak, 4);
    assert.equal(u.longest, 5);
});

test("updateStreak: Monday after Friday → streak continues", async () => {
    const db = mockDB("2026-04-20", {
        current_streak: 2, longest_streak: 2, last_attendance_date: "2026-04-17",
    });
    await updateStreak({ DB: db }, "u1", "s1");
    const u = db.getUpdate();
    assert.equal(u.streak, 3);
    assert.equal(u.longest, 3);
});

test("updateStreak: gap in attendance → streak resets to 1", async () => {
    const db = mockDB("2026-04-24", {
        current_streak: 5, longest_streak: 10, last_attendance_date: "2026-04-21",
    });
    await updateStreak({ DB: db }, "u1", "s1");
    const u = db.getUpdate();
    assert.equal(u.streak, 1);
    assert.equal(u.longest, 10);
});

test("updateStreak: same day duplicate → no update", async () => {
    const db = mockDB("2026-04-24", {
        current_streak: 3, longest_streak: 5, last_attendance_date: "2026-04-24",
    });
    await updateStreak({ DB: db }, "u1", "s1");
    assert.equal(db.getUpdate(), null);
});

test("updateStreak: new streak beats longest → longest updated", async () => {
    const db = mockDB("2026-04-24", {
        current_streak: 9, longest_streak: 9, last_attendance_date: "2026-04-23",
    });
    await updateStreak({ DB: db }, "u1", "s1");
    const u = db.getUpdate();
    assert.equal(u.streak, 10);
    assert.equal(u.longest, 10);
});

test("updateStreak: no stream found → no-op", async () => {
    const db = mockDB(null, null);
    await updateStreak({ DB: db }, "u1", "s1");
    assert.equal(db.getUpdate(), null);
});

test("updateStreak: no user found → no-op", async () => {
    const db = mockDB("2026-04-24", null);
    await updateStreak({ DB: db }, "u1", "s1");
    assert.equal(db.getUpdate(), null);
});
