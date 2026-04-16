# Post-launch hardening roadmap

Durable list of security/hardening items identified after the
go-live. Three items (Dependabot, CodeQL, weekly audit-chain verify)
shipped with this document; the rest are tracked here with concrete
fix shapes so they don't drift into "someday." Ordered by codex's
priority ranking (attacker ROI × likelihood / fix cost).

## Shipped with this commit

- [x] **Dependabot weekly.** `.github/dependabot.yml` — GH Actions +
      pip ecosystems, Mon 09:00 ET cadence, auto-merge OFF (manual
      review per bump).
- [x] **CodeQL SAST.** `.github/workflows/codeql.yml` — JS +
      Python on PR/push + weekly cron. High-severity fails the PR.
- [x] **Weekly automated audit-chain verify.** `.github/workflows/
      audit-chain-weekly.yml` — runs `scripts/verify_audit_chain.py`
      every Monday, Discord-pings on failure.

## Open (ordered by priority)

### 1. CSP `unsafe-inline` removal

- Location: [`pages/functions/_middleware.js:16`](../pages/functions/_middleware.js),
  every `<style>` and inline `<script>` block across `pages/*.html`.
- Problem: CSP still allows `'unsafe-inline'` on `script-src` and
  `style-src`. One HTML-injection via user-rendered content = script
  execution. The biggest remaining web-tier attack surface.
- Fix path: externalise inline JS to `/*.js` files, externalise
  inline CSS to `/style.css` (or per-page files), then tighten the
  CSP header to drop `'unsafe-inline'`. Use nonces only as a last
  resort for a handful of blocks that can't be externalised.
- Estimate: 1–2 days, one PR per page to keep each diff reviewable.
- Gate to starting: first-week mobile + a11y hands-on pass, so we
  don't migrate styles that are about to change.

### 2. Signed commits + signed release tags

- Location: repo-wide, affects every future commit + any tag.
- Problem: a compromised GitHub session can push unsigned commits
  that auto-deploy. Provenance is weaker than it looks.
- Fix path: maintainer generates GPG key, enables
  `commit.gpgsign=true` + `tag.gpgsign=true` in their local config,
  adds the public key to GitHub profile. Turn on the "Require signed
  commits" branch-protection rule on `main`. Add `--verify-signatures`
  to the deploy workflow's checkout step. Cut annotated `v1.x.y`
  release tags per deploy for rollback clarity.
- Estimate: ~1 hour operator setup + a small CI PR.

### 3. D1 + R2 backup / DR

- Location: runbook (`docs/RUNBOOK.md`) has no backup procedure; no
  scheduled export workflow.
- Problem: recovery posture is entirely implicit. One operator
  `wrangler d1 execute` typo or a Cloudflare incident and we're
  reconstructing from audit-log fragments.
- Fix path: write RPO/RTO targets (proposal: RPO 24h, RTO 4h), add
  a weekly workflow that runs `wrangler d1 export` + R2 object-
  version snapshot into a separate R2 bucket with 90-day retention,
  document the restore drill in RUNBOOK. Rehearse once.
- Estimate: 1 day. Needs a second R2 bucket.

### 4. Turnstile bootstrap SRI / drift monitoring

- Location: [`pages/index.html:12`](../pages/index.html),
  [`pages/recover.html:12`](../pages/recover.html).
- Problem: the Turnstile `api.js` is loaded without integrity
  attribute. If Cloudflare's CDN is compromised or they silently
  change the bootstrap, our pages execute it.
- Fix path: Cloudflare doesn't publish stable SRI hashes for
  Turnstile (the bootstrap changes to ship A/B variants), so hard-
  pinning isn't feasible. Instead: schedule a weekly hash-drift
  check that pins the current hash, alerts on change, and requires
  a human to re-approve. Low operational cost, eyes on a rarely-
  changing critical boundary.
- Estimate: 2 hours for the drift monitor.

### 5. Real-traffic rate-limit re-tune plan

- Location: [`register.js:12`](../pages/functions/api/register.js),
  [`recover.js:57`](../pages/functions/api/recover.js),
  [`preflight/channel.js:60`](../pages/functions/api/preflight/channel.js),
  [`me/[token].js:13`](../pages/functions/api/me/[token].js).
- Problem: rate limits are launch guesses. Two-week post-launch
  measurement will show which caps never get hit (loosen) and
  which produce false-positives (investigate).
- Fix path: 14 days after launch, query `audit_log` for
  `rate_limited` audit writes per endpoint, cross-reference against
  any `[ACCOUNT]` support mail, adjust based on the p95 hit-rate
  of legit flows. Write findings into `docs/SLO.md` so next
  operator knows the reasoning.
- Estimate: 2 hours of query + write-up at T+14 days.

### 6. Deploy-path reviewer gate

- Location: [`.github/workflows/deploy-prod.yml:55`](../.github/workflows/deploy-prod.yml).
- Problem: auto-deploy from `main` means one compromised maintainer
  session ships anything. The `production` GH environment has no
  required reviewers configured.
- Fix path: add one required reviewer (the operator themselves, or
  a bot account) to the `production` environment gate. Non-tag
  deploys require click-to-approve. Trade-off: adds ~30s of
  operator friction per deploy. For a cert issuer, reasonable.
- Estimate: 5 minutes of GH Settings clicks.

### 7. HSTS preload submission

- Location: [`_middleware.js:50`](../pages/functions/_middleware.js),
  README trust section.
- Problem: HSTS is on but preload isn't submitted. Browsers can be
  downgrade-attacked on first visit.
- Fix path: blocked on `cpe.simplycyber.io` apex DNS wiring
  (documented as in-flight). Once the operator-controlled apex is
  canonical, set `max-age=63072000; includeSubDomains; preload`
  and submit at `hstspreload.org`.
- Estimate: 5 minutes, post-DNS.

## Cadence

Aim: one hardening item per 1–2 week sprint for the next 60 days.
Codex's priority ordering is the default — skip past #1 only if
launch-day data makes one of the others more urgent (e.g., a real
CSP escape would jump CSP to P0).

## Review

Re-run the codex hardening sweep at T+30 and T+90. Expect new
items to surface once real traffic data is in; close stale ones.
