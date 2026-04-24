# README Engineer Plugin — Design Spec

## Overview

A Claude Code plugin that generates, audits, scores, and iteratively improves README files across any project. Packages the responsive diagram rendering pipeline, multi-viewport screenshot analysis, and multi-dimensional scoring rubric developed in the sc-cpe project into a reusable tool.

**Core thesis:** Your README is your portfolio. This plugin treats it as a first-class engineering artifact — scored, tested, and iterated on like production code.

## Plugin Structure

```
~/.claude/plugins/readme-engineer/
├── .claude-plugin/
│   └── plugin.json                # name, description, version, author
├── skills/
│   ├── readme-generate/
│   │   └── SKILL.md               # Generate README from scratch
│   ├── readme-audit/
│   │   └── SKILL.md               # Score + screenshot + gap analysis
│   ├── readme-improve/
│   │   └── SKILL.md               # Iterative audit → fix → verify loop
│   └── readme-diagrams/
│       └── SKILL.md               # Mermaid render + responsive optimization
├── scripts/
│   ├── screenshot.mjs             # Puppeteer multi-viewport screenshotter
│   ├── score.mjs                  # Markdown parser + rubric scorer
│   └── render-diagrams.mjs        # Mermaid CLI wrapper (dark/light SVG)
├── templates/
│   ├── rubric.md                  # Scoring rubric definition + examples
│   ├── sections.md                # README section templates + best practices
│   └── mermaid-config/
│       ├── dark.json              # Dark theme (slate palette)
│       └── light.json             # Light theme (light slate palette)
└── README.md                      # Plugin's own README (dogfooded)
```

## Skills

### 1. `readme-generate` — Generate a README from Scratch

**Trigger phrases:** "generate a README", "create a README", "I need a README", "write me a README"

**Workflow:**
1. Scan codebase structure: file tree, entry points, directory conventions
2. Detect project type: read package.json, Cargo.toml, pyproject.toml, go.mod, etc.
3. Discover infrastructure: CI configs (.github/workflows/), Docker, deploy configs
4. Map API surface: scan for route definitions, exported functions, CLI commands
5. Identify test setup: test files, test commands in package.json scripts
6. Check for existing docs: CONTRIBUTING.md, LICENSE, docs/ directory, CHANGELOG
7. Generate README.md with all sections from the sections template
8. Generate Mermaid diagram sources (.mmd) for architecture + primary workflow
9. Render diagrams to dark/light SVGs
10. Wire up `<picture>` elements in README
11. Run audit at the end to show starting score + next improvements

**Output:** README.md, docs/assets/diagram-*.mmd, docs/assets/diagram-*-{dark,light}.svg

### 2. `readme-audit` — Score and Analyze

**Trigger phrases:** "audit my README", "score my README", "how's my README", "rate my README"

**Workflow:**
1. Run `score.mjs` for automated structural checks
2. Screenshot README at 5 viewports (375, 768, 1280, 1920, 2560px)
3. Claude evaluates subjective dimensions (impact quality, decision depth, clarity)
4. Produce scorecard with per-dimension breakdown
5. Produce prioritized fix list ordered by impact-per-effort
6. Analyze screenshots for responsive issues (diagram readability, layout problems)

**Output:** Scorecard printed to terminal, screenshot PNGs in temp directory (not committed)

### 3. `readme-improve` — Iterative Improvement Loop

**Trigger phrases:** "improve my README", "make my README better", "iterate on my README", "fix my README"

**Workflow (the self-improving loop):**
1. Run full audit → get scorecard (baseline)
2. Identify the lowest-scoring dimension
3. For each gap in that dimension:
   a. Analyze codebase for relevant missing info (test commands, API routes, deploy URLs, metrics)
   b. Generate or improve the section content
   c. Update README.md
4. Re-render any diagrams if architecture/workflow sections changed
5. Re-screenshot at all viewports
6. Re-score and report delta: "Technical: 6→8 (+2), Visual: 7→9 (+2), Impact: 4→7 (+3) = 17→24 (+7)"
7. If any dimension < 7/10, suggest next priority fixes
8. Loop until all dimensions ≥ 7 or user decides to stop

**Regression guard:** After each change, verify no dimension dropped. If it did, revert that change and try a different approach.

### 4. `readme-diagrams` — Diagram Pipeline

**Trigger phrases:** "render my diagrams", "fix my diagrams", "optimize diagrams", "diagram responsive"

**Workflow:**
1. Find all `.mmd` files in project (default: `docs/assets/diagram-*.mmd`)
2. Render each to dark + light SVGs using mermaid-cli with bundled theme configs
3. Extract viewBox dimensions, compute aspect ratios
4. Flag problematic ratios (outside 1.5:1 to 6:1 range)
5. For flagged diagrams, suggest fixes:
   - Linear chains in TD → switch to LR with subgraph lanes
   - Linear chains in LR → add subgraph grouping for height
   - Very tall → reduce nodes, shorten labels, restructure
   - Very wide → split into multiple diagrams
6. Screenshot to verify responsive rendering at all viewports
7. Generate `<picture>` markdown snippets for README embedding

**Aspect ratio targets:**
- Ideal: 2:1 to 4:1
- Acceptable: 1.5:1 to 6:1
- Needs work: outside this range

## Scoring Rubric

### Technical Completeness (10 points)

| Points | Element | Detection Method |
|--------|---------|-----------------|
| 2 | Problem statement / what it does | Look for h1 + first paragraph, or "What is" / "About" section |
| 1 | Tech stack + dependencies | Look for tech stack section, badges, or dependency file references |
| 2 | Architecture diagram | Look for `<picture>` elements or mermaid blocks with architecture content |
| 2 | API surface / key features | Look for Features, API, Endpoints sections with substantive content |
| 1 | Setup / install / deploy instructions | Look for "Getting Started", "Install", "Deploy", "Quick Start" with code blocks |
| 1 | Testing commands | Look for "Test" section with runnable commands |
| 1 | Contributing guide | Look for CONTRIBUTING.md link or "Contributing" section |

### Visual Polish (10 points)

| Points | Element | Detection Method |
|--------|---------|-----------------|
| 3 | Responsive diagrams with dark/light theming | `<picture>` with `prefers-color-scheme` media queries + SVG sources |
| 2 | Badges (CI, license, coverage, deploy) | Shield.io / badge image patterns in first 20 lines |
| 2 | Clean section hierarchy | Proper h2/h3 nesting, no h1 jumps, balanced section sizes |
| 2 | Screenshot or GIF demo | Image/GIF in first 30% of README showing the product running |
| 1 | Consistent formatting | No broken links, no bare URLs, consistent code block languages |

### Business Impact (10 points)

| Points | Element | Detection Method |
|--------|---------|-----------------|
| 2 | Clear problem statement | First 3 paragraphs explain WHY this exists, not just what |
| 2 | Quantifiable impact | Numbers: users, requests/sec, uptime, reduction in X, size of dataset |
| 2 | Design decisions explained | "Why" sections, architecture rationale, tradeoff discussion |
| 2 | Live demo / deployed URL | Link to running instance, demo site, or playground |
| 2 | Key differentiators | What makes this different from alternatives, unique approach |

### Scoring Output Format

```
README Score: 22/30
  Technical:  8/10  ██████████████████░░  (missing: test commands)
  Visual:     9/10  ██████████████████░░  (missing: GIF demo)
  Impact:     5/10  ██████████░░░░░░░░░░  (missing: metrics, design decisions, differentiators)

  Priority fixes (highest impact first):
  1. [Impact +2] Add quantifiable metrics — scan codebase for performance data, user counts
  2. [Impact +2] Add design decisions section — explain architecture choices
  3. [Technical +1] Add test commands — scan package.json scripts.test
  4. [Visual +1] Add product screenshot or GIF demo
```

## Scripts

### `screenshot.mjs`

Evolved from `sc-cpe/scripts/readme-screenshot.mjs`. Changes:
- Accepts CLI args: `--readme <path>` (default: ./README.md), `--out <dir>` (default: temp dir), `--viewports <json>` (default: 5 standard viewports)
- Finds SVG diagrams by scanning for `<picture>` elements in README or by globbing `docs/assets/diagram-*-dark.svg`
- Returns JSON to stdout: `{ viewports: [{ name, width, height, file, diagrams: [{ name, viewBox, rendered }] }] }`
- Simulates GitHub dark-mode container (max-width: 1012px, #0d1117 background)
- Adds viewport badge + rendered-size annotations per diagram

**Viewports:**
| Name | Width | Height |
|------|-------|--------|
| mobile | 375 | 812 |
| tablet | 768 | 1024 |
| laptop | 1280 | 800 |
| desktop | 1920 | 1080 |
| widescreen | 2560 | 1440 |

### `score.mjs`

Parses README markdown and returns a JSON scorecard. Automated checks:
- Section detection: regex for common heading patterns (h1-h3)
- Badge detection: `![...](https://img.shields.io/...)` or similar badge patterns
- Diagram detection: `<picture>` elements with `prefers-color-scheme`, mermaid code blocks, SVG/PNG images
- Link validation: extract all URLs, check for obvious issues (relative path exists? no bare URLs?)
- Code block counting: setup/install/test sections should have code blocks
- Demo detection: look for GIF/screenshot images, deployed URLs

Returns:
```json
{
  "total": 22,
  "technical": { "score": 8, "max": 10, "gaps": ["test commands"] },
  "visual": { "score": 9, "max": 10, "gaps": ["GIF demo"] },
  "impact": { "score": 5, "max": 10, "gaps": ["metrics", "design decisions", "differentiators"] },
  "sections_found": ["hero", "architecture", "features", "quickstart", "deploy"],
  "sections_missing": ["testing", "design-decisions"],
  "badges_count": 3,
  "diagrams_count": 5,
  "links": { "total": 12, "broken": 0 },
  "word_count": 1840
}
```

### `render-diagrams.mjs`

Wraps mermaid-cli. Workflow:
1. Glob for `*.mmd` files (default: `docs/assets/diagram-*.mmd`)
2. For each, render dark SVG (using bundled `dark.json` config) + light SVG (using `light.json`)
3. Extract viewBox from rendered SVGs, compute aspect ratio
4. Return JSON report:
```json
{
  "diagrams": [
    {
      "name": "architecture",
      "source": "docs/assets/diagram-architecture.mmd",
      "dark": "docs/assets/diagram-architecture-dark.svg",
      "light": "docs/assets/diagram-architecture-light.svg",
      "viewBox": "0 0 1478 384",
      "ratio": 3.85,
      "status": "good"
    }
  ],
  "flagged": []
}
```

## Templates

### `sections.md` — README Section Templates

Each section has a template with:
- What goes in it (purpose)
- Length target (1 sentence? 1 paragraph? table?)
- Example from a high-quality README
- Common mistakes to avoid

**Section order (recommended):**
1. **Hero** — Project name, one-line description, badges row
2. **What + Why** — 2-3 sentences: what problem this solves and why it matters
3. **How It Works** — Diagram + 2-3 sentence walkthrough
4. **Architecture** — Diagram + component descriptions (brief, not exhaustive)
5. **Features** — Themed groups (not flat bullet list), with visual categorization
6. **Quick Start** — Copy-paste commands to get running in < 2 minutes
7. **API / Key Interfaces** — Table or organized list of endpoints/functions
8. **Testing** — Exact commands with expected output
9. **Deployment** — Step-by-step for production
10. **Design Decisions** — 2-3 key architectural choices with rationale
11. **Observability** — How to monitor, health checks, key metrics
12. **Contributing** — Link to CONTRIBUTING.md or inline short guide
13. **License** — One line + link

### `rubric.md` — Scoring Examples

For each dimension, provides examples of what 10/10 vs 5/10 vs 2/10 looks like, so the skill can calibrate its subjective judgments consistently across projects.

## Mermaid Theme Configs

### `dark.json`
```json
{
  "theme": "dark",
  "themeVariables": {
    "primaryColor": "#1e293b",
    "primaryTextColor": "#e2e8f0",
    "primaryBorderColor": "#475569",
    "lineColor": "#64748b",
    "secondaryColor": "#334155",
    "tertiaryColor": "#1e293b",
    "background": "transparent",
    "mainBkg": "#1e293b",
    "nodeBorder": "#475569",
    "clusterBkg": "#0f172a",
    "clusterBorder": "#334155",
    "titleColor": "#e2e8f0",
    "edgeLabelBackground": "transparent"
  },
  "flowchart": {
    "curve": "basis",
    "padding": 16,
    "useMaxWidth": true,
    "htmlLabels": true
  }
}
```

### `light.json`
```json
{
  "theme": "default",
  "themeVariables": {
    "primaryColor": "#f1f5f9",
    "primaryTextColor": "#1e293b",
    "primaryBorderColor": "#cbd5e1",
    "lineColor": "#94a3b8",
    "secondaryColor": "#e2e8f0",
    "tertiaryColor": "#f8fafc",
    "background": "transparent",
    "mainBkg": "#f1f5f9",
    "nodeBorder": "#cbd5e1",
    "clusterBkg": "#f8fafc",
    "clusterBorder": "#e2e8f0",
    "titleColor": "#1e293b",
    "edgeLabelBackground": "transparent"
  },
  "flowchart": {
    "curve": "basis",
    "padding": 16,
    "useMaxWidth": true,
    "htmlLabels": true
  }
}
```

## Dependencies

The plugin requires these npm packages to be available globally or in the project:
- `puppeteer` (screenshot.mjs)
- `@mermaid-js/mermaid-cli` (render-diagrams.mjs)

The skills check for these on invocation and offer to install if missing.

## Workflow: End-to-End Example

**New project, no README:**
```
User: "generate a README"
→ readme-generate scans codebase
→ Produces README.md + 2-3 diagrams (.mmd + dark/light SVGs)
→ Runs audit: "Starting score: 19/30. Visual: 6/10 (no badges, no demo). Run 'improve my README' to iterate."
```

**Existing project, wants better README:**
```
User: "audit my README"
→ readme-audit scores: 14/30
→ "Technical 6/10, Visual 3/10, Impact 5/10. Biggest gap: no diagrams, no badges, no dark/light theming."

User: "improve my README"
→ readme-improve loop iteration 1: adds diagrams + badges → 14→20
→ Iteration 2: adds metrics + design decisions → 20→25
→ Iteration 3: adds GIF demo + test commands → 25→28
→ "Score: 28/30. All dimensions ≥ 8. Ship it."
```

**Diagram maintenance after architecture change:**
```
User: "render my diagrams"
→ readme-diagrams re-renders all .mmd files
→ Flags: "cicd diagram ratio 11:1 — suggest adding subgraph grouping"
→ Applies fix, re-renders, screenshots to verify
```
