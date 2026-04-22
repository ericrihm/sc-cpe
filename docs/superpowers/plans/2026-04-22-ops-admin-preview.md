# Ops Hardening, Admin Panel UI, and PR Previews — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three independent improvements: durable R2 backups with restore, admin panel UI for 5 API endpoints, and CF Pages PR preview environment.

**Architecture:** Part 1 adds R2 upload to the existing backup workflow and a new restore script. Part 2 adds one new API endpoint (`GET /api/admin/user/{id}/certs`) and extends `admin.html`/`admin.js` with five new UI sections wired to existing endpoints via a new `postJson()` helper. Part 3 adds `[env.preview]` wrangler config, seed data, and a GitHub Actions preview deploy workflow.

**Tech Stack:** Cloudflare Pages Functions (JS), D1, R2, KV, GitHub Actions, wrangler CLI, vanilla JS (no framework)

**XSS note:** All dynamic values rendered in the admin UI are passed through the existing `escapeHtml()` function (defined in `admin.js`) before DOM insertion, following the established pattern used throughout the file for `renderStats`, `renderHeartbeats`, `renderFeedback`, `renderAuditTrail`, etc.

---

## File Map

### Part 1: Backup/Restore
- Modify: `scripts/backup_d1.sh` — add `--upload-r2` flag
- Modify: `.github/workflows/backup.yml` — add R2 upload step + restore test job
- Create: `scripts/restore_d1.sh` — list/download/restore from R2
- Modify: `docs/RUNBOOK.md` — add Disaster Recovery section

### Part 2: Admin Panel UI
- Create: `pages/functions/api/admin/user/[id]/certs.js` — new endpoint
- Modify: `pages/admin.html` — add 5 new sections (users, appeals, attendance, revoke form)
- Modify: `pages/admin.js` — add `postJson()`, render functions, event handlers
- Modify: `pages/admin.css` — add styles for new sections

### Part 3: PR Previews
- Modify: `pages/wrangler.toml` — add `[env.preview]` bindings
- Create: `db/seed-preview.sql` — fixture data for preview environment
- Create: `.github/workflows/deploy-preview.yml` — PR-triggered preview deploy

---

### Task 1: Backup script R2 upload

**Files:**
- Modify: `scripts/backup_d1.sh`

- [ ] **Step 1: Add `--upload-r2` flag to backup script**

Replace the entire contents of `scripts/backup_d1.sh` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

DB_NAME="sc-cpe"
BUCKET="sc-cpe-backups"
BACKUP_DIR="${BACKUP_DIR:-/tmp/sc-cpe-backups}"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/sc-cpe-${TIMESTAMP}.sql"
UPLOAD_R2=false

for arg in "$@"; do
  case "$arg" in
    --upload-r2) UPLOAD_R2=true ;;
  esac
done

mkdir -p "$BACKUP_DIR"

echo "Exporting D1 database ${DB_NAME}..."
npx wrangler d1 export "$DB_NAME" --output="$BACKUP_FILE"

echo "Backup saved to ${BACKUP_FILE}"
echo "Size: $(du -h "$BACKUP_FILE" | cut -f1)"

if [ "$UPLOAD_R2" = true ]; then
  R2_KEY="d1-backup-${TIMESTAMP}.sql"
  echo "Uploading to R2 bucket ${BUCKET} as ${R2_KEY}..."
  npx wrangler r2 object put "${BUCKET}/${R2_KEY}" --file="$BACKUP_FILE"
  echo "R2 upload complete."
fi

# Keep only last 4 backups (4 weeks)
ls -t "${BACKUP_DIR}"/sc-cpe-*.sql 2>/dev/null | tail -n +5 | xargs -r rm -f
echo "Cleanup complete. Backups retained: $(ls "${BACKUP_DIR}"/sc-cpe-*.sql | wc -l)"
```

- [ ] **Step 2: Verify syntax**

Run: `bash -n scripts/backup_d1.sh`
Expected: no output (syntax OK)

- [ ] **Step 3: Commit**

```bash
git add scripts/backup_d1.sh
git commit -m "feat(backup): add --upload-r2 flag for durable R2 storage"
```

---

### Task 2: Update backup workflow for R2 upload + restore test

**Files:**
- Modify: `.github/workflows/backup.yml`

- [ ] **Step 1: Replace backup workflow with R2 upload and restore test**

Replace the entire contents of `.github/workflows/backup.yml` with:

```yaml
name: Weekly D1 backup

on:
  schedule:
    - cron: "0 6 * * 0"   # Sunday 06:00 UTC
  workflow_dispatch:
    inputs:
      test_restore:
        description: "Run a restore round-trip test after backup"
        required: false
        default: "false"
        type: boolean

jobs:
  backup:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install wrangler
        run: npm install -g wrangler

      - name: Export D1 and upload to R2
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          BACKUP_DIR: /tmp/sc-cpe-backups
        run: bash scripts/backup_d1.sh --upload-r2

      - name: Upload backup artifact
        uses: actions/upload-artifact@v4
        with:
          name: d1-backup-${{ github.run_id }}
          path: /tmp/sc-cpe-backups/sc-cpe-*.sql
          retention-days: 30

  restore-test:
    if: inputs.test_restore == true
    needs: backup
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install wrangler
        run: npm install -g wrangler

      - name: Download backup artifact
        uses: actions/download-artifact@v4
        with:
          name: d1-backup-${{ github.run_id }}
          path: /tmp/restore-test

      - name: Create throwaway D1 and test restore
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          BACKUP_FILE=$(ls -t /tmp/restore-test/sc-cpe-*.sql | head -1)
          echo "Testing restore with: $BACKUP_FILE"

          echo "Creating throwaway database..."
          npx wrangler d1 create sc-cpe-restore-test 2>&1 | tee /tmp/create-output.txt
          DB_ID=$(grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' /tmp/create-output.txt | head -1)
          echo "Throwaway DB ID: $DB_ID"

          echo "Applying migrations..."
          for f in $(ls db/migrations/*.sql 2>/dev/null | sort); do
            echo "  Applying $(basename $f)..."
            npx wrangler d1 execute sc-cpe-restore-test --remote --file "$f" || true
          done

          echo "Importing backup..."
          npx wrangler d1 execute sc-cpe-restore-test --remote --file "$BACKUP_FILE"

          echo "Running sanity queries..."
          npx wrangler d1 execute sc-cpe-restore-test --remote --json \
            --command "SELECT 'users' AS tbl, COUNT(*) AS cnt FROM users UNION ALL SELECT 'audit_log', COUNT(*) FROM audit_log UNION ALL SELECT 'attendance', COUNT(*) FROM attendance UNION ALL SELECT 'certs', COUNT(*) FROM certs" \
            | jq '.[0].results[]'

          echo "Cleaning up throwaway database..."
          npx wrangler d1 delete sc-cpe-restore-test --force || echo "Cleanup failed (non-fatal)"

          echo "Restore test PASSED"
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/backup.yml'))"`
Expected: no error

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/backup.yml
git commit -m "feat(backup): add R2 upload step and restore round-trip test job"
```

---

### Task 3: Restore script

**Files:**
- Create: `scripts/restore_d1.sh`

- [ ] **Step 1: Create the restore script**

Create `scripts/restore_d1.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

DB_NAME="sc-cpe"
BUCKET="sc-cpe-backups"
CONFIRM=false
LIST=false
LATEST=false
KEY=""

usage() {
  echo "Usage:"
  echo "  $0 --list                    List available backups in R2"
  echo "  $0 --latest --confirm        Restore the most recent backup"
  echo "  $0 <r2-key> --confirm        Restore a specific backup"
  echo ""
  echo "Options:"
  echo "  --confirm    Required safety flag for restore operations"
  echo "  --list       List backups without restoring"
  echo "  --latest     Select the most recent backup"
  exit 1
}

if [ $# -eq 0 ]; then usage; fi

for arg in "$@"; do
  case "$arg" in
    --list)    LIST=true ;;
    --latest)  LATEST=true ;;
    --confirm) CONFIRM=true ;;
    --help|-h) usage ;;
    -*)        echo "Unknown flag: $arg"; usage ;;
    *)         KEY="$arg" ;;
  esac
done

if [ "$LIST" = true ]; then
  echo "Available backups in R2 bucket '${BUCKET}':"
  npx wrangler r2 object list "$BUCKET" --json \
    | jq -r '.[] | "\(.key)\t\(.size) bytes\t\(.uploaded)"' \
    | sort -r
  exit 0
fi

if [ "$CONFIRM" != true ]; then
  echo "ERROR: --confirm flag required for restore operations."
  echo "This will overwrite the production database. Use with care."
  exit 1
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

if [ "$LATEST" = true ]; then
  echo "Finding most recent backup..."
  KEY=$(npx wrangler r2 object list "$BUCKET" --json \
    | jq -r '.[] | .key' | sort -r | head -1)
  if [ -z "$KEY" ]; then
    echo "ERROR: No backups found in R2 bucket '${BUCKET}'"
    exit 1
  fi
  echo "Latest backup: $KEY"
fi

if [ -z "$KEY" ]; then
  echo "ERROR: No backup key specified. Use --latest or provide a key."
  usage
fi

RESTORE_FILE="${TMPDIR}/restore.sql"
echo "Downloading ${KEY} from R2..."
npx wrangler r2 object get "${BUCKET}/${KEY}" --file="$RESTORE_FILE"
echo "Downloaded: $(du -h "$RESTORE_FILE" | cut -f1)"

echo ""
echo "=== RESTORING to D1 database '${DB_NAME}' ==="
echo ""
npx wrangler d1 execute "$DB_NAME" --remote --file="$RESTORE_FILE"

echo ""
echo "Running sanity checks..."
npx wrangler d1 execute "$DB_NAME" --remote --json \
  --command "SELECT 'users' AS tbl, COUNT(*) AS cnt FROM users UNION ALL SELECT 'audit_log', COUNT(*) FROM audit_log UNION ALL SELECT 'attendance', COUNT(*) FROM attendance UNION ALL SELECT 'certs', COUNT(*) FROM certs" \
  | jq '.[0].results[]'

echo ""
echo "Restore complete."
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/restore_d1.sh`

- [ ] **Step 3: Verify syntax**

Run: `bash -n scripts/restore_d1.sh`
Expected: no output (syntax OK)

- [ ] **Step 4: Commit**

```bash
git add scripts/restore_d1.sh
git commit -m "feat(backup): add restore script for R2 backups"
```

---

### Task 4: Runbook disaster recovery section

**Files:**
- Modify: `docs/RUNBOOK.md`

- [ ] **Step 1: Add disaster recovery section to RUNBOOK.md**

Append to the end of `docs/RUNBOOK.md`:

```markdown

## Disaster Recovery

### How backups work

- **Weekly** (Sunday 06:00 UTC): GitHub Actions exports D1 via `wrangler d1 export`,
  uploads the SQL dump to R2 bucket `sc-cpe-backups`, and saves a 30-day GitHub
  artifact as secondary copy.
- **Retention:** R2 keeps 90 days (lifecycle rule). GitHub artifacts keep 30 days.
  Local `/tmp` keeps 4 files (rotated).
- **Data loss window:** Up to 7 days (weekly cadence). If this is too wide,
  increase the cron frequency in `.github/workflows/backup.yml`.

### List available backups

```sh
bash scripts/restore_d1.sh --list
```

### Restore from R2

```sh
# Most recent backup
bash scripts/restore_d1.sh --latest --confirm

# Specific backup
bash scripts/restore_d1.sh d1-backup-20260420-060012.sql --confirm
```

**Warning:** This overwrites the production D1 database. All data written
since the backup was taken will be lost.

### Test the restore path

Trigger the backup workflow with `test_restore=true`:

```sh
gh workflow run backup.yml -f test_restore=true
```

This creates a throwaway D1, imports the backup, runs sanity queries, and
deletes the throwaway DB. It does not touch production.

### After a restore

1. Run `scripts/smoke_hardening.sh` to verify endpoints work.
2. Check `/api/admin/audit-chain-verify` — the chain should be intact
   (the backup includes all audit rows).
3. Check heartbeats — cron workers will re-beat on their next tick.
4. Any registrations, attendance, or certs created since the backup was
   taken are lost. Communicate to affected users if applicable.
```

- [ ] **Step 2: Commit**

```bash
git add docs/RUNBOOK.md
git commit -m "docs: add disaster recovery section to runbook"
```

---

### Task 5: User certs API endpoint

**Files:**
- Create: `pages/functions/api/admin/user/[id]/certs.js`

- [ ] **Step 1: Create the endpoint**

Create `pages/functions/api/admin/user/[id]/certs.js`:

```javascript
import { json, isAdmin } from "../../../../_lib.js";

export async function onRequestGet({ params, request, env }) {
    if (!(await isAdmin(env, request))) {
        return json({ error: "unauthorized" }, 401);
    }
    const userId = params.id;
    if (!userId || userId.length < 10) {
        return json({ error: "invalid_user_id" }, 400);
    }

    const { results = [] } = await env.DB.prepare(`
        SELECT id, public_token, period_yyyymm, cert_kind, stream_id,
               cpe_total, sessions_count, state, revoked_at,
               revocation_reason, created_at, supersedes_cert_id
          FROM certs
         WHERE user_id = ?1
      ORDER BY created_at DESC
    `).bind(userId).all();

    return json({ ok: true, user_id: userId, count: results.length, certs: results });
}
```

- [ ] **Step 2: Commit**

```bash
git add pages/functions/api/admin/user/[id]/certs.js
git commit -m "feat(admin): add GET /api/admin/user/{id}/certs endpoint"
```

---

### Task 6: Admin HTML — add new sections

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Add Users, Appeals, and Manual Attendance sections to admin.html**

In `pages/admin.html`, find the existing block (the audit trail section):

```html
    <div class="section-h">Audit trail</div>
```

Insert the following **before** that line:

```html
    <div class="section-h">Users</div>
    <div class="admin-search" id="user-search-wrap">
      <form id="user-search-form" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <input type="search" id="user-q" placeholder="Search by name, email, channel, or ID..." style="flex:1;min-width:200px;">
        <button type="submit" class="refresh">Search</button>
      </form>
      <div id="user-search-err" class="err" hidden></div>
    </div>
    <div id="user-results"></div>

    <div class="section-h">Revoke certificate</div>
    <form id="revoke-form" style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;margin-bottom:20px;">
      <input type="text" id="revoke-token" placeholder="public_token (64 hex chars)" style="flex:1;min-width:260px;" required>
      <input type="text" id="revoke-reason" placeholder="Reason (required)" style="flex:2;min-width:200px;" required maxlength="500">
      <button type="submit" class="refresh" style="background:#5c1515;">Revoke</button>
    </form>
    <div id="revoke-result" hidden></div>

    <div class="section-h">Appeals <span class="muted" id="appeals-count-badge"></span></div>
    <div style="margin-bottom:8px;">
      <select id="appeals-state-filter" style="background:#111820;color:#e5ecf2;border:1px solid #2a3644;padding:4px 8px;border-radius:4px;font-size:12px;">
        <option value="open">Open</option>
        <option value="granted">Granted</option>
        <option value="denied">Denied</option>
        <option value="any">All</option>
      </select>
      <button class="refresh" id="appeals-refresh" style="margin-left:6px;">Load</button>
    </div>
    <div id="appeals-rows"></div>
    <p id="appeals-empty" class="muted" style="font-size:12px;" hidden>No appeals found.</p>

    <div class="section-h">Manual attendance grant</div>
    <form id="attendance-form" style="display:flex;flex-direction:column;gap:8px;max-width:480px;margin-bottom:20px;">
      <input type="text" id="att-user-id" placeholder="User ID (ULID)" required>
      <input type="text" id="att-stream-id" placeholder="Stream ID (ULID)" required>
      <textarea id="att-reason" placeholder="Reason (required)" rows="2" required maxlength="2000"></textarea>
      <input type="text" id="att-resolver" placeholder="Your admin handle" required maxlength="80">
      <input type="number" id="att-rule-version" value="1" min="1" style="width:80px;" required>
      <button type="submit" class="refresh" style="align-self:flex-start;">Grant attendance</button>
    </form>
    <div id="attendance-result" hidden></div>

```

- [ ] **Step 2: Commit**

```bash
git add pages/admin.html
git commit -m "feat(admin): add HTML sections for users, appeals, revoke, attendance"
```

---

### Task 7: Admin CSS — styles for new sections

**Files:**
- Modify: `pages/admin.css`

- [ ] **Step 1: Add styles for new admin sections**

Append the following to the end of `pages/admin.css` (before the `@media` block):

Find the line:
```css
@media (max-width: 640px) {
```

Insert before it:

```css
.admin-search input[type="search"] { background: #111820; color: #e5ecf2; border: 1px solid #2a3644; padding: 6px 10px; border-radius: 4px; font-size: 12px; }
#user-results .user-row { background: #111820; border: 1px solid #2a3644; border-radius: 6px; padding: 12px 14px; margin-bottom: 8px; }
#user-results .user-row .user-header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; margin-bottom: 6px; }
#user-results .user-row .user-header .user-name { font-weight: 600; }
#user-results .user-row .user-meta { font-size: 12px; color: #6b7a8a; display: flex; flex-wrap: wrap; gap: 4px 16px; }
#user-results .user-row .user-actions { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
.cert-sub-table { width: 100%; margin-top: 8px; font-size: 12px; }
.cert-sub-table th { font-size: 10px; }
.cert-sub-table td { padding: 4px 8px; }
.cert-sub-table .cert-actions { display: flex; gap: 4px; }
.cert-sub-table .cert-actions button { font-size: 11px; padding: 2px 8px; }
#revoke-form input, #revoke-form textarea { background: #111820; color: #e5ecf2; border: 1px solid #2a3644; padding: 6px 10px; border-radius: 4px; font-size: 12px; }
#appeals-rows .appeal-row { background: #111820; border: 1px solid #2a3644; border-radius: 6px; padding: 10px 14px; margin-bottom: 6px; font-size: 12px; display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 4px 12px; }
#appeals-rows .appeal-row .ar-label { color: #6b7a8a; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
#appeals-rows .appeal-actions { grid-column: 1 / -1; display: flex; gap: 6px; margin-top: 6px; }
#attendance-form input, #attendance-form textarea { background: #111820; color: #e5ecf2; border: 1px solid #2a3644; padding: 6px 10px; border-radius: 4px; font-size: 12px; font-family: monospace; }
.result-box { padding: 10px 14px; border-radius: 4px; margin-bottom: 12px; font-size: 13px; }
.result-box.success { background: #1a2e1a; border: 1px solid #2a6b2a; color: #88dd88; }
.result-box.error { background: #3a1818; border: 1px solid #6b2a2a; color: #ffb4b4; }
```

- [ ] **Step 2: Commit**

```bash
git add pages/admin.css
git commit -m "feat(admin): add CSS for user search, appeals, revoke, attendance sections"
```

---

### Task 8: Admin JS — postJson helper and user search

**Files:**
- Modify: `pages/admin.js`

This task adds the `postJson()` helper function and the user search section with cert sub-table expansion and inline cert action buttons (resend/revoke/reissue).

All dynamic values are passed through the existing `escapeHtml()` function before DOM insertion, following the established pattern used by `renderStats`, `renderFeedback`, `renderAuditTrail`, etc. in the same file.

- [ ] **Step 1: Add postJson helper after fetchJson**

In `pages/admin.js`, find the closing `}` of the `fetchJson` function (the line that reads `    return r.json();` followed by `}`). Insert **after** that closing brace:

```javascript
async function postJson(path, body) {
    var opts = {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    };
    if (TOKEN && TOKEN !== "__cookie__") {
        opts.headers["Authorization"] = "Bearer " + TOKEN;
    }
    var r = await fetch(path, opts);
    var j = await r.json().catch(function () { return {}; });
    if (r.status === 401) throw new Error("unauthorized");
    if (!r.ok) throw new Error(j.error || path + " → HTTP " + r.status);
    return j;
}
```

- [ ] **Step 2: Add user search handler and renderer**

Find the line that starts with `(async function init() {` (the IIFE at the end of the file). Insert the following block **before** that line. This code uses `escapeHtml()` for all dynamic values — the same function already defined at line 215 of admin.js and used by all existing render functions.

```javascript
// --- User Search ---
var userSearchForm = $("#user-search-form");
if (userSearchForm) {
    userSearchForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        var q = $("#user-q").value.trim();
        var errEl = $("#user-search-err");
        errEl.hidden = true;
        if (q.length < 2) {
            errEl.textContent = "Query must be at least 2 characters.";
            errEl.hidden = false;
            return;
        }
        var btn = userSearchForm.querySelector("button");
        btn.disabled = true;
        btn.textContent = "Searching…";
        try {
            var data = await fetchJson("/api/admin/users?q=" + encodeURIComponent(q) + "&limit=20");
            renderUserResults(data.users || []);
        } catch (err) {
            errEl.textContent = err.message;
            errEl.hidden = false;
        } finally {
            btn.disabled = false;
            btn.textContent = "Search";
        }
    });
}

function renderUserResults(users) {
    var box = $("#user-results");
    box.textContent = "";
    if (users.length === 0) {
        var p = document.createElement("p");
        p.className = "muted";
        p.style.fontSize = "12px";
        p.textContent = "No users found.";
        box.appendChild(p);
        return;
    }
    for (var i = 0; i < users.length; i++) {
        var u = users[i];
        box.appendChild(buildUserRow(u));
    }
}

function buildUserRow(u) {
    var row = document.createElement("div");
    row.className = "user-row";

    var header = document.createElement("div");
    header.className = "user-header";
    var nameSpan = document.createElement("span");
    nameSpan.className = "user-name";
    nameSpan.textContent = u.legal_name;
    var emailSpan = document.createElement("span");
    emailSpan.className = "muted";
    emailSpan.style.fontSize = "12px";
    emailSpan.textContent = u.email;
    var stateSpan = document.createElement("span");
    stateSpan.className = u.state === "active" ? "ok" : (u.deleted_at ? "stale" : "warn");
    stateSpan.style.fontSize = "12px";
    stateSpan.textContent = u.state;
    header.append(nameSpan, emailSpan, stateSpan);

    var meta = document.createElement("div");
    meta.className = "user-meta";
    var idEl = document.createElement("span");
    var idCode = document.createElement("code");
    idCode.textContent = u.id;
    idEl.textContent = "ID: ";
    idEl.appendChild(idCode);
    meta.appendChild(idEl);
    if (u.yt_channel_id) {
        var ytSpan = document.createElement("span");
        ytSpan.textContent = "YT: " + (u.yt_display_name_seen || u.yt_channel_id);
        meta.appendChild(ytSpan);
    }
    var attSpan = document.createElement("span");
    attSpan.textContent = "Attendance: " + u.attendance_count;
    meta.appendChild(attSpan);
    var certSpan = document.createElement("span");
    certSpan.textContent = "Certs: " + u.cert_count;
    meta.appendChild(certSpan);
    if (u.open_appeal_count > 0) {
        var appSpan = document.createElement("span");
        appSpan.className = "warn";
        appSpan.textContent = "Appeals: " + u.open_appeal_count;
        meta.appendChild(appSpan);
    }

    var actions = document.createElement("div");
    actions.className = "user-actions";
    var certsBtn = document.createElement("button");
    certsBtn.className = "refresh view-certs-btn";
    certsBtn.dataset.uid = u.id;
    certsBtn.style.cssText = "font-size:11px;padding:3px 10px;";
    certsBtn.textContent = "View certs (" + u.cert_count + ")";
    var grantBtn = document.createElement("button");
    grantBtn.className = "refresh grant-att-btn";
    grantBtn.dataset.uid = u.id;
    grantBtn.style.cssText = "font-size:11px;padding:3px 10px;";
    grantBtn.textContent = "Grant attendance";
    actions.append(certsBtn, grantBtn);

    var expand = document.createElement("div");
    expand.className = "cert-expand";
    expand.id = "certs-" + u.id;

    row.append(header, meta, actions, expand);
    return row;
}

function renderCertSubTable(container, certs) {
    container.textContent = "";
    if (certs.length === 0) {
        var p = document.createElement("p");
        p.className = "muted";
        p.style.cssText = "font-size:12px;margin:6px 0;";
        p.textContent = "No certs.";
        container.appendChild(p);
        return;
    }
    var table = document.createElement("table");
    table.className = "cert-sub-table";
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    ["Period", "Kind", "State", "CPE", "Token", "Actions"].forEach(function (t) {
        var th = document.createElement("th");
        th.textContent = t;
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    for (var i = 0; i < certs.length; i++) {
        var c = certs[i];
        var tr = document.createElement("tr");
        var tdPeriod = document.createElement("td");
        tdPeriod.textContent = c.period_yyyymm;
        var tdKind = document.createElement("td");
        tdKind.textContent = c.cert_kind;
        var tdState = document.createElement("td");
        tdState.className = c.state === "revoked" ? "stale" : (c.state === "delivered" || c.state === "generated" ? "ok" : "muted");
        tdState.textContent = c.state;
        var tdCpe = document.createElement("td");
        tdCpe.textContent = c.cpe_total;
        var tdToken = document.createElement("td");
        tdToken.className = "muted";
        tdToken.style.cssText = "font-family:monospace;font-size:11px;";
        tdToken.textContent = c.public_token.slice(0, 12) + "…";
        var tdActions = document.createElement("td");
        tdActions.className = "cert-actions";
        if (c.state !== "revoked" && c.state !== "regenerated" && c.state !== "pending") {
            var resendBtn = document.createElement("button");
            resendBtn.className = "refresh cert-resend-btn";
            resendBtn.dataset.token = c.public_token;
            resendBtn.textContent = "Resend";
            var revokeBtn = document.createElement("button");
            revokeBtn.className = "refresh cert-revoke-btn";
            revokeBtn.dataset.token = c.public_token;
            revokeBtn.style.background = "#5c1515";
            revokeBtn.textContent = "Revoke";
            var reissueBtn = document.createElement("button");
            reissueBtn.className = "refresh cert-reissue-btn";
            reissueBtn.dataset.certid = c.id;
            reissueBtn.textContent = "Re-issue";
            tdActions.append(resendBtn, revokeBtn, reissueBtn);
        } else {
            var statusSpan = document.createElement("span");
            statusSpan.className = c.state === "revoked" ? "stale" : "muted";
            statusSpan.textContent = c.state === "pending" ? "pending" : (c.state === "revoked" ? "revoked" : "superseded");
            tdActions.appendChild(statusSpan);
        }
        tr.append(tdPeriod, tdKind, tdState, tdCpe, tdToken, tdActions);
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);
}

// Delegate click for user search action buttons
var userResultsBox = $("#user-results");
if (userResultsBox) {
    userResultsBox.addEventListener("click", async function (e) {
        var certsBtn = e.target.closest(".view-certs-btn");
        if (certsBtn && !certsBtn.disabled) {
            var uid = certsBtn.dataset.uid;
            var expandEl = document.getElementById("certs-" + uid);
            if (expandEl.childNodes.length > 0) { expandEl.textContent = ""; return; }
            certsBtn.disabled = true;
            certsBtn.textContent = "Loading…";
            try {
                var data = await fetchJson("/api/admin/user/" + encodeURIComponent(uid) + "/certs");
                renderCertSubTable(expandEl, data.certs || []);
            } catch (err) {
                expandEl.textContent = "";
                var errDiv = document.createElement("div");
                errDiv.className = "err";
                errDiv.textContent = err.message;
                expandEl.appendChild(errDiv);
            } finally {
                certsBtn.disabled = false;
                certsBtn.textContent = "View certs";
            }
            return;
        }
        var attBtn = e.target.closest(".grant-att-btn");
        if (attBtn) {
            var attField = $("#att-user-id");
            if (attField) {
                attField.value = attBtn.dataset.uid;
                attField.scrollIntoView({ behavior: "smooth" });
            }
            return;
        }
        var resendBtn = e.target.closest(".cert-resend-btn");
        if (resendBtn && !resendBtn.disabled) {
            if (!confirm("Resend cert email?")) return;
            resendBtn.disabled = true;
            resendBtn.textContent = "sending…";
            try {
                await postJson("/api/admin/cert/" + encodeURIComponent(resendBtn.dataset.token) + "/resend", {});
                var sentSpan = document.createElement("span");
                sentSpan.className = "ok";
                sentSpan.style.fontSize = "11px";
                sentSpan.textContent = "sent";
                resendBtn.replaceWith(sentSpan);
            } catch (err) {
                resendBtn.disabled = false;
                resendBtn.textContent = "retry";
                resendBtn.title = err.message;
            }
            return;
        }
        var revBtn = e.target.closest(".cert-revoke-btn");
        if (revBtn && !revBtn.disabled) {
            var reason = prompt("Reason for revocation? (required)");
            if (!reason) return;
            revBtn.disabled = true;
            revBtn.textContent = "revoking…";
            try {
                await postJson("/api/admin/revoke", { public_token: revBtn.dataset.token, reason: reason });
                var revokedSpan = document.createElement("span");
                revokedSpan.className = "stale";
                revokedSpan.style.fontSize = "11px";
                revokedSpan.textContent = "revoked";
                revBtn.replaceWith(revokedSpan);
            } catch (err) {
                revBtn.disabled = false;
                revBtn.textContent = "retry";
                revBtn.title = err.message;
            }
            return;
        }
        var reissueBtn = e.target.closest(".cert-reissue-btn");
        if (reissueBtn && !reissueBtn.disabled) {
            var reissueReason = prompt("Reason for re-issue? (required)");
            if (!reissueReason) return;
            reissueBtn.disabled = true;
            reissueBtn.textContent = "queueing…";
            try {
                await postJson("/api/admin/cert/" + encodeURIComponent(reissueBtn.dataset.certid) + "/reissue", { reason: reissueReason });
                var queuedSpan = document.createElement("span");
                queuedSpan.className = "muted";
                queuedSpan.style.fontSize = "11px";
                queuedSpan.textContent = "reissue queued";
                reissueBtn.replaceWith(queuedSpan);
            } catch (err) {
                reissueBtn.disabled = false;
                reissueBtn.textContent = "retry";
                reissueBtn.title = err.message;
            }
            return;
        }
    });
}
```

- [ ] **Step 3: Commit**

```bash
git add pages/admin.js
git commit -m "feat(admin): add postJson helper, user search UI with cert actions"
```

---

### Task 9: Admin JS — appeals queue and revoke form

**Files:**
- Modify: `pages/admin.js`

- [ ] **Step 1: Add appeals loader, renderer, and revoke form handler**

In `pages/admin.js`, find the closing `});` of the `userResultsBox.addEventListener` block (added in Task 8). Insert the following **after** that closing and **before** the `(async function init() {` line:

```javascript
// --- Standalone Revoke Form ---
var revokeForm = $("#revoke-form");
if (revokeForm) {
    revokeForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        var tokenVal = $("#revoke-token").value.trim();
        var reasonVal = $("#revoke-reason").value.trim();
        var resultEl = $("#revoke-result");
        if (!tokenVal || tokenVal.length < 32) {
            resultEl.className = "result-box error";
            resultEl.textContent = "Token must be at least 32 characters.";
            resultEl.hidden = false;
            return;
        }
        if (!reasonVal) {
            resultEl.className = "result-box error";
            resultEl.textContent = "Reason is required.";
            resultEl.hidden = false;
            return;
        }
        if (!confirm("Revoke cert " + tokenVal.slice(0, 12) + "…?")) return;
        var btn = revokeForm.querySelector("button");
        btn.disabled = true;
        btn.textContent = "Revoking…";
        try {
            var data = await postJson("/api/admin/revoke", { public_token: tokenVal, reason: reasonVal });
            resultEl.className = "result-box success";
            resultEl.textContent = data.already_revoked
                ? "Already revoked at " + data.revoked_at
                : "Revoked cert " + data.cert_id + " at " + data.revoked_at;
            resultEl.hidden = false;
            revokeForm.reset();
        } catch (err) {
            resultEl.className = "result-box error";
            resultEl.textContent = err.message;
            resultEl.hidden = false;
        } finally {
            btn.disabled = false;
            btn.textContent = "Revoke";
        }
    });
}

// --- Appeals Queue ---
async function loadAppeals() {
    var state = $("#appeals-state-filter").value;
    var box = $("#appeals-rows");
    box.textContent = "";
    var empty = $("#appeals-empty");
    empty.hidden = true;
    try {
        var data = await fetchJson("/api/admin/appeals?state=" + encodeURIComponent(state) + "&limit=50");
        var appeals = data.appeals || [];
        var badge = $("#appeals-count-badge");
        if (badge) badge.textContent = appeals.length > 0 ? "(" + appeals.length + ")" : "";
        if (appeals.length === 0) { empty.hidden = false; return; }
        for (var i = 0; i < appeals.length; i++) {
            box.appendChild(buildAppealRow(appeals[i]));
        }
    } catch (err) {
        var errDiv = document.createElement("div");
        errDiv.className = "err";
        errDiv.textContent = err.message;
        box.appendChild(errDiv);
    }
}

function buildAppealRow(a) {
    var row = document.createElement("div");
    row.className = "appeal-row";

    var dateDiv = document.createElement("div");
    var dateLbl = document.createElement("div");
    dateLbl.className = "ar-label";
    dateLbl.textContent = "Date";
    var dateVal = document.createElement("div");
    dateVal.className = "ar-val";
    dateVal.textContent = a.claimed_date;
    dateDiv.append(dateLbl, dateVal);

    var userDiv = document.createElement("div");
    var userLbl = document.createElement("div");
    userLbl.className = "ar-label";
    userLbl.textContent = "User";
    var userVal = document.createElement("div");
    userVal.className = "ar-val";
    userVal.textContent = a.legal_name;
    var userEmail = document.createElement("span");
    userEmail.className = "muted";
    userEmail.style.fontSize = "11px";
    userEmail.textContent = a.email;
    var br = document.createElement("br");
    userVal.append(br, userEmail);
    userDiv.append(userLbl, userVal);

    var streamDiv = document.createElement("div");
    var streamLbl = document.createElement("div");
    streamLbl.className = "ar-label";
    streamLbl.textContent = "Stream";
    var streamVal = document.createElement("div");
    streamVal.className = "ar-val";
    streamVal.textContent = a.stream_title || a.claimed_stream_id || "—";
    streamDiv.append(streamLbl, streamVal);

    var stateDiv = document.createElement("div");
    var stateLbl = document.createElement("div");
    stateLbl.className = "ar-label";
    stateLbl.textContent = "State";
    var stateVal = document.createElement("div");
    stateVal.className = "ar-val " + (a.state === "open" ? "warn" : (a.state === "granted" ? "ok" : "stale"));
    stateVal.textContent = a.state;
    stateDiv.append(stateLbl, stateVal);

    row.append(dateDiv, userDiv, streamDiv, stateDiv);

    if (a.evidence_text) {
        var evDiv = document.createElement("div");
        evDiv.style.gridColumn = "1 / -1";
        var evLbl = document.createElement("div");
        evLbl.className = "ar-label";
        evLbl.textContent = "Evidence";
        var evVal = document.createElement("div");
        evVal.className = "ar-val";
        evVal.textContent = a.evidence_text;
        evDiv.append(evLbl, evVal);
        row.appendChild(evDiv);
    }

    if (a.evidence_url) {
        var urlDiv = document.createElement("div");
        urlDiv.style.gridColumn = "1 / -1";
        var urlLbl = document.createElement("div");
        urlLbl.className = "ar-label";
        urlLbl.textContent = "Evidence URL";
        var urlVal = document.createElement("div");
        urlVal.className = "ar-val";
        var link = document.createElement("a");
        link.href = a.evidence_url;
        link.target = "_blank";
        link.rel = "noopener";
        link.style.color = "#7cc3ff";
        link.textContent = a.evidence_url;
        urlVal.appendChild(link);
        urlDiv.append(urlLbl, urlVal);
        row.appendChild(urlDiv);
    }

    if (a.state === "open") {
        var actionsDiv = document.createElement("div");
        actionsDiv.className = "appeal-actions";
        var grantBtn = document.createElement("button");
        grantBtn.className = "refresh appeal-grant-btn";
        grantBtn.dataset.aid = a.id;
        grantBtn.textContent = "Grant";
        var denyBtn = document.createElement("button");
        denyBtn.className = "refresh appeal-deny-btn";
        denyBtn.dataset.aid = a.id;
        denyBtn.style.background = "#5c1515";
        denyBtn.textContent = "Deny";
        actionsDiv.append(grantBtn, denyBtn);
        row.appendChild(actionsDiv);
    } else if (a.resolution_notes) {
        var resDiv = document.createElement("div");
        resDiv.style.gridColumn = "1 / -1";
        var resLbl = document.createElement("div");
        resLbl.className = "ar-label";
        resLbl.textContent = "Resolution";
        var resVal = document.createElement("div");
        resVal.className = "ar-val";
        resVal.textContent = (a.resolved_by || "") + ": " + a.resolution_notes + " (" + (a.resolved_at || "") + ")";
        resDiv.append(resLbl, resVal);
        row.appendChild(resDiv);
    }

    return row;
}

var appealsRefreshBtn = $("#appeals-refresh");
if (appealsRefreshBtn) appealsRefreshBtn.addEventListener("click", loadAppeals);
var appealsFilter = $("#appeals-state-filter");
if (appealsFilter) appealsFilter.addEventListener("change", loadAppeals);

// Delegate appeal action buttons
var appealsBox = $("#appeals-rows");
if (appealsBox) {
    appealsBox.addEventListener("click", async function (e) {
        var grantBtn = e.target.closest(".appeal-grant-btn");
        var denyBtn = e.target.closest(".appeal-deny-btn");
        var btn = grantBtn || denyBtn;
        if (!btn || btn.disabled) return;
        var decision = grantBtn ? "grant" : "deny";
        var resolver = prompt("Your admin handle:");
        if (!resolver) return;
        var notes = prompt("Resolution notes (optional):") || "";
        var body = { decision: decision, resolver: resolver, notes: notes };
        if (decision === "grant") {
            var rv = prompt("Rule version (default 1):", "1");
            body.rule_version = parseInt(rv, 10) || 1;
        }
        btn.disabled = true;
        btn.textContent = decision === "grant" ? "Granting…" : "Denying…";
        try {
            await postJson("/api/admin/appeals/" + encodeURIComponent(btn.dataset.aid) + "/resolve", body);
            loadAppeals();
        } catch (err) {
            btn.disabled = false;
            btn.textContent = decision === "grant" ? "Grant" : "Deny";
            btn.title = err.message;
            alert("Error: " + err.message);
        }
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add pages/admin.js
git commit -m "feat(admin): add appeals queue UI and standalone revoke form"
```

---

### Task 10: Admin JS — manual attendance form and auto-load appeals

**Files:**
- Modify: `pages/admin.js`

- [ ] **Step 1: Add manual attendance form handler**

In `pages/admin.js`, find the closing `});` of the `appealsBox.addEventListener` block (added in Task 9). Insert **after** it:

```javascript
// --- Manual Attendance Grant ---
var attendanceForm = $("#attendance-form");
if (attendanceForm) {
    attendanceForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        var resultEl = $("#attendance-result");
        resultEl.hidden = true;
        var body = {
            user_id: $("#att-user-id").value.trim(),
            stream_id: $("#att-stream-id").value.trim(),
            reason: $("#att-reason").value.trim(),
            resolver: $("#att-resolver").value.trim(),
            rule_version: parseInt($("#att-rule-version").value, 10) || 1,
        };
        if (!body.user_id || body.user_id.length < 10) {
            resultEl.className = "result-box error";
            resultEl.textContent = "User ID required.";
            resultEl.hidden = false;
            return;
        }
        if (!body.stream_id || body.stream_id.length < 10) {
            resultEl.className = "result-box error";
            resultEl.textContent = "Stream ID required.";
            resultEl.hidden = false;
            return;
        }
        if (!body.reason) {
            resultEl.className = "result-box error";
            resultEl.textContent = "Reason required.";
            resultEl.hidden = false;
            return;
        }
        if (!body.resolver) {
            resultEl.className = "result-box error";
            resultEl.textContent = "Resolver handle required.";
            resultEl.hidden = false;
            return;
        }
        if (!confirm("Grant attendance for user " + body.user_id.slice(0, 10) + "…?")) return;
        var btn = attendanceForm.querySelector("button");
        btn.disabled = true;
        btn.textContent = "Granting…";
        try {
            var data = await postJson("/api/admin/attendance", body);
            resultEl.className = "result-box success";
            resultEl.textContent = "Attendance granted. Earned CPE: " + data.earned_cpe + ". Source: " + data.source;
            resultEl.hidden = false;
            attendanceForm.reset();
            $("#att-rule-version").value = "1";
        } catch (err) {
            resultEl.className = "result-box error";
            resultEl.textContent = err.message;
            resultEl.hidden = false;
        } finally {
            btn.disabled = false;
            btn.textContent = "Grant attendance";
        }
    });
}
```

- [ ] **Step 2: Add appeals auto-load on page init**

In `pages/admin.js`, find the block inside `init()`:

```javascript
            TOKEN = "__cookie__";
            $("#login").style.display = "none";
            $("#app").style.display = "";
            load();
            return;
```

Change `load();` to include `loadAppeals()`:

```javascript
            TOKEN = "__cookie__";
            $("#login").style.display = "none";
            $("#app").style.display = "";
            load();
            loadAppeals();
            return;
```

- [ ] **Step 3: Commit**

```bash
git add pages/admin.js
git commit -m "feat(admin): add manual attendance form and auto-load appeals on init"
```

---

### Task 11: Wrangler preview environment config

**Files:**
- Modify: `pages/wrangler.toml`

- [ ] **Step 1: Add preview environment section**

Append to the end of `pages/wrangler.toml`:

```toml

# --- Preview environment ---
# Used by CF Pages for non-production branch deploys (PR previews).
# Create these resources once:
#   wrangler d1 create sc-cpe-preview
#   wrangler kv:namespace create sc-cpe-rate-preview
#   wrangler r2 bucket create sc-cpe-certs-preview
# Then paste the IDs below.

[env.preview.vars]
POLL_WINDOW_TZ = "America/New_York"
POLL_WINDOW_START_HOUR = "8"
POLL_WINDOW_END_HOUR = "11"
POLL_WINDOW_DAYS = "1,2,3,4,5"

[[env.preview.d1_databases]]
binding = "DB"
database_name = "sc-cpe-preview"
database_id = "PREVIEW_D1_ID_PLACEHOLDER"

[[env.preview.kv_namespaces]]
binding = "RATE_KV"
id = "PREVIEW_KV_ID_PLACEHOLDER"

[[env.preview.r2_buckets]]
binding = "CERTS_BUCKET"
bucket_name = "sc-cpe-certs-preview"
```

**Note for the implementer:** The `PREVIEW_D1_ID_PLACEHOLDER` and `PREVIEW_KV_ID_PLACEHOLDER` values must be replaced with real IDs after running the `wrangler d1 create` and `wrangler kv:namespace create` commands. These commands require Cloudflare credentials and must be run by the repo owner. Add a comment in the PR noting this.

- [ ] **Step 2: Commit**

```bash
git add pages/wrangler.toml
git commit -m "feat(preview): add wrangler.toml preview environment bindings"
```

---

### Task 12: Preview seed data

**Files:**
- Create: `db/seed-preview.sql`

- [ ] **Step 1: Create seed data file**

Create `db/seed-preview.sql`:

```sql
-- Seed data for the CF Pages preview environment.
-- All INSERTs use OR IGNORE so the file is idempotent (safe to re-run).

-- Admin user
INSERT OR IGNORE INTO admin_users (email) VALUES ('ericrihm@gmail.com');

-- Test users
INSERT OR IGNORE INTO users
  (id, email, legal_name, dashboard_token, badge_token, state,
   verification_code, code_expires_at, legal_name_attested,
   age_attested_13plus, tos_version_accepted, created_at, verified_at)
VALUES
  ('01JPREVIEW00ACTIVEUSER001', 'testuser@example.com', 'Test User',
   'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
   'b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6b1b2',
   'active', NULL, NULL, 1, 1, 'v1',
   '2026-04-01T00:00:00Z', '2026-04-01T01:00:00Z'),
  ('01JPREVIEW00PENDINGUSER01', 'pending@example.com', 'Pending User',
   'c1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6c1c2',
   'd1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6d1d2',
   'pending_verification', 'PREVW001', '2026-12-31T00:00:00Z', 1, 1, 'v1',
   '2026-04-15T00:00:00Z', NULL);

-- Streams
INSERT OR IGNORE INTO streams
  (id, yt_video_id, title, scheduled_date, actual_start_at, actual_end_at,
   state, messages_scanned, distinct_attendees, created_at)
VALUES
  ('01JPREVIEWSTREAM00000001', 'prev1ewV1deo1d', 'Daily Threat Briefing — Preview Apr 1',
   '2026-04-01', '2026-04-01T12:00:00Z', '2026-04-01T13:00:00Z',
   'complete', 42, 1, '2026-04-01T11:00:00Z'),
  ('01JPREVIEWSTREAM00000002', 'prev1ewV1deo2d', 'Daily Threat Briefing — Preview Apr 2',
   '2026-04-02', '2026-04-02T12:00:00Z', '2026-04-02T13:00:00Z',
   'complete', 38, 1, '2026-04-02T11:00:00Z');

-- Attendance
INSERT OR IGNORE INTO attendance
  (user_id, stream_id, earned_cpe, first_msg_id, first_msg_at,
   first_msg_sha256, first_msg_len, rule_version, source, created_at)
VALUES
  ('01JPREVIEW00ACTIVEUSER001', '01JPREVIEWSTREAM00000001', 0.5,
   'preview-msg-001', '2026-04-01T12:05:00Z',
   'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 0,
   1, 'poll', '2026-04-01T12:05:00Z'),
  ('01JPREVIEW00ACTIVEUSER001', '01JPREVIEWSTREAM00000002', 0.5,
   'preview-msg-002', '2026-04-02T12:05:00Z',
   'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 0,
   1, 'poll', '2026-04-02T12:05:00Z');

-- KV config
INSERT OR IGNORE INTO kv (k, v, updated_at) VALUES
  ('rule_version.current', '1', '2026-04-01T00:00:00Z'),
  ('rule_version.1.cpe_per_day', '0.5', '2026-04-01T00:00:00Z'),
  ('rule_version.1.pre_start_grace_min', '15', '2026-04-01T00:00:00Z');
```

- [ ] **Step 2: Commit**

```bash
git add db/seed-preview.sql
git commit -m "feat(preview): add seed data for preview environment"
```

---

### Task 13: Preview deploy workflow

**Files:**
- Create: `.github/workflows/deploy-preview.yml`

- [ ] **Step 1: Create the preview deploy workflow**

Create `.github/workflows/deploy-preview.yml`:

```yaml
name: Deploy PR Preview

on:
  pull_request:
    types: [opened, synchronize, reopened]

concurrency:
  group: preview-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  deploy-preview:
    runs-on: ubuntu-latest
    environment: production
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install wrangler
        run: npm install -g wrangler

      - name: Apply migrations to preview D1
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          for f in $(ls db/migrations/*.sql 2>/dev/null | sort); do
            echo "Applying $(basename $f) to preview D1..."
            npx wrangler d1 execute sc-cpe-preview --remote --file "$f" || true
          done

      - name: Seed preview data
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          npx wrangler d1 execute sc-cpe-preview --remote --file db/seed-preview.sql

      - name: Deploy Pages preview
        id: deploy
        uses: cloudflare/wrangler-action@9acf94ace14e7dc412b076f2c5c20b8ce93c79cd  # v3.15.0
        with:
          apiToken: ${{ secrets.CLOUDFLARE_DEPLOY_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: pages
          command: pages deploy . --project-name sc-cpe-web --branch "${{ github.head_ref }}"

      - name: Comment preview URL on PR
        uses: actions/github-script@v7
        with:
          script: |
            const branch = context.payload.pull_request.head.ref;
            const slug = branch.replace(/[^a-z0-9-]/gi, '-').slice(0, 28);
            const url = `https://${slug}.sc-cpe-web.pages.dev`;
            const body = `### Preview deployed\n\n${url}\n\nPreview uses an isolated D1/R2/KV with seed data — not production.`;

            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
            });
            const existing = comments.find(c => c.body && c.body.includes('Preview deployed'));
            if (existing) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: existing.id,
                body,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body,
              });
            }
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy-preview.yml
git commit -m "feat(preview): add PR preview deploy workflow with seed data"
```

---

### Task 14: Update CLAUDE.md known gaps

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update known gaps section**

In `CLAUDE.md`, find the line:

```
- CF Pages PR previews remain disabled — current bindings are prod;
  enabling them requires a separate `sc-cpe-preview` D1/R2/KV.
```

Replace those two lines with:

```
- CF Pages PR previews configured — `wrangler.toml` has `[env.preview]`
  section with placeholder IDs. To activate: run `wrangler d1 create
  sc-cpe-preview`, `wrangler kv:namespace create sc-cpe-rate-preview`,
  `wrangler r2 bucket create sc-cpe-certs-preview`, and paste the IDs
  into the `[env.preview]` section of `pages/wrangler.toml`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update known gaps — PR previews configured, backups durable"
```

---

### Task 15: Smoke test

- [ ] **Step 1: Run the test suite**

Run: `bash scripts/test.sh`
Expected: All tests pass (no new tests added — the backup/restore scripts are bash, admin UI is frontend JS, preview is workflow YAML)

- [ ] **Step 2: Verify admin.html loads without JS errors**

Start a local server (if available) or visually inspect that:
- `admin.html` references all new element IDs that `admin.js` queries
- All `$()` selectors in admin.js have matching HTML elements
- `postJson()` is defined before it is called
- `loadAppeals()` is defined before it is called in `init()`

Cross-check these IDs exist in `admin.html`:
- `#user-search-form`, `#user-q`, `#user-search-err`, `#user-results`
- `#revoke-form`, `#revoke-token`, `#revoke-reason`, `#revoke-result`
- `#appeals-state-filter`, `#appeals-refresh`, `#appeals-rows`, `#appeals-empty`, `#appeals-count-badge`
- `#attendance-form`, `#att-user-id`, `#att-stream-id`, `#att-reason`, `#att-resolver`, `#att-rule-version`, `#attendance-result`

- [ ] **Step 3: Verify backup script syntax**

Run: `bash -n scripts/backup_d1.sh && bash -n scripts/restore_d1.sh`
Expected: No output (syntax OK for both)

- [ ] **Step 4: Verify workflow YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/backup.yml')); yaml.safe_load(open('.github/workflows/deploy-preview.yml')); print('OK')"`
Expected: `OK`

- [ ] **Step 5: Final commit if any fixes needed**

Only if smoke test revealed issues that needed fixing.
