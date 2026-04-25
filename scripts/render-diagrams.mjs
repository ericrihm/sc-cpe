#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

const ASSETS = join(import.meta.dirname, "..", "docs", "assets");
const DARK_CONFIG = join(ASSETS, "mermaid-config.json");
const LIGHT_CONFIG = join(ASSETS, "mermaid-config-light.json");

const MIN_RATIO = 0.3;
const MAX_RATIO = 6.0;

const checkMode = process.argv.includes("--check");
const warnings = [];

function q(s) { return `"${s}"`; }

function mmdc(src, out, config) {
  const cmd = ["mmdc", "-i", q(src), "-o", q(out), "-c", q(config), "-b", "transparent"].join(" ");
  const r = spawnSync(cmd, { stdio: "pipe", shell: true });
  if (r.status !== 0) throw new Error(r.stderr?.toString().trim() || `exit ${r.status}`);
}

const mmds = readdirSync(ASSETS).filter((f) => f.endsWith(".mmd"));
if (!mmds.length) {
  console.log("No .mmd files found in docs/assets/");
  process.exit(0);
}

for (const file of mmds) {
  const src = join(ASSETS, file);
  const stem = file.replace(/\.mmd$/, "");
  const darkOut = join(ASSETS, `${stem}-dark.svg`);
  const lightOut = join(ASSETS, `${stem}-light.svg`);

  for (const [config, out] of [
    [DARK_CONFIG, darkOut],
    [LIGHT_CONFIG, lightOut],
  ]) {
    try {
      mmdc(src, out, config);
      console.log(`  ✓ ${basename(out)}`);
    } catch (e) {
      console.error(`  ✗ ${basename(out)}: ${e.message}`);
      process.exitCode = 1;
    }
  }

  const svg = readFileSync(lightOut, "utf8");
  const vb = svg.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/);
  if (vb) {
    const w = parseFloat(vb[1]);
    const h = parseFloat(vb[2]);
    const ratio = w / h;
    const tag = ratio < MIN_RATIO || ratio > MAX_RATIO ? "⚠" : "✓";
    console.log(`  ${tag} ${stem} aspect ${ratio.toFixed(2)}:1 (${Math.round(w)}×${Math.round(h)})`);
    if (tag === "⚠") {
      warnings.push(`${stem}: ${ratio.toFixed(2)}:1 — consider fixed width in <img> tag`);
    }
  }
}

if (warnings.length) {
  console.log("\nAspect ratio warnings:");
  warnings.forEach((w) => console.log(`  ${w}`));
  if (checkMode) process.exitCode = 1;
}
