import { json, isAdmin } from "../../../_lib.js";

export function parseRange(url) {
    const range = url.searchParams.get("range") || "30d";
    const validRanges = { "7d": 7, "30d": 30, "90d": 90 };
    const days = validRanges[range];
    if (range === "all") {
        return { range: "all", since: null, granularity: url.searchParams.get("granularity") || "monthly" };
    }
    if (!days) {
        return { range: "30d", since: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10), granularity: "daily" };
    }
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    const autoGran = days <= 30 ? "daily" : "weekly";
    const granularity = url.searchParams.get("granularity") || autoGran;
    return { range, since, granularity };
}

export function groupByKey(granularity) {
    if (granularity === "weekly") return "strftime('%Y-W%W', {col})";
    if (granularity === "monthly") return "strftime('%Y-%m', {col})";
    return "date({col})";
}

export async function guardAdmin(env, request) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }
    return null;
}
