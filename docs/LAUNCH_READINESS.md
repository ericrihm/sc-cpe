# Launch readiness checklist

Durable checklist of the launch-prep work that can't be done as a code
change — the things that require operator action, physical infrastructure,
or deliberate human process. Track-and-check. Each item has an owner
(just `eric` today), a due-window, and a concrete verification step.

## P0 — blocks public announcement

- [ ] **DMARC DNS record on `signalplane.co`** — starting policy
      `v=DMARC1; p=quarantine; rua=mailto:certs@signalplane.co; adkim=s; aspf=s; fo=1`.
      (rua= points at `certs@` — the single launch-time inbox — because
      `dmarc-reports@` would silently black-hole. DMARC aggregate XMLs
      are noisy but filter easily: subject contains `Report domain:`.)
      Verify with `dig TXT _dmarc.signalplane.co +short`. After ~2
      weeks of clean `rua` reports, tighten to `p=reject`.

- [ ] **Discord alert webhook live** — create in the SC ops Discord,
      push as repo secret `DISCORD_ALERT_WEBHOOK`. Fire `gh workflow
      run watchdog.yml -R ericrihm/sc-cpe` and confirm the alert lands.

- [ ] **Single inbox online** — `certs@signalplane.co` forwarding to
      an address you actively watch. One mailbox at launch by design
      (upstream email limit). Filter rules on the receiving mailbox:
      `Subject:[SECURITY]` → label SECURITY, `Subject:[PRIVACY]` →
      label PRIVACY, `Subject:[ACCOUNT]` → label SUPPORT,
      `Subject:[CERT]` → label CERT-DISPUTE, `Subject:Report domain:`
      → label DMARC-AUTO (auto-archive). Everything else falls through
      to the default inbox for human review.
      Send a test to `certs@signalplane.co` with each prefix; confirm
      arrival and correct labelling before announcement.

- [ ] **Wrangler rollback rehearsal on `email-sender`** — pick a
      quiet weekday outside 08:00–11:00 ET. Run
      `cd workers/email-sender && wrangler rollback` interactively,
      time the round-trip, re-deploy. Goal: < 90 s end-to-end.
      See `docs/RUNBOOK.md#rollback` for the full commands.

## P1 — first-week operator tasks

- [ ] **Dry-run monthly cert issuance at realistic volume** — fire
      `monthly-certs.yml` via `workflow_dispatch` with a synthetic
      period. Observe signing throughput, TSA behaviour, Resend
      delivery rate. Expected first live run: start of next calendar
      month, so the dry-run confirms we won't discover a regression
      on prod month-end.

- [ ] **Accessibility pass** — manual, 20 minutes per page. The four
      public pages: register (`/`), recover (`/recover.html`), dashboard
      (`/dashboard.html?t=...`), verify (`/verify.html`).
      Test matrix:
      - Mobile Safari + Chrome Android (smallest sensible width).
      - Keyboard-only (Tab / Shift-Tab / Space / Enter through every
        interactive element).
      - VoiceOver or TalkBack: labels readable, landmark nav works.
      Fix anything broken before announcement.

- [ ] **Explicit SLOs document** — file a docs/SLO.md with targeted
      monthly numbers. Starting proposals (based on the SLAs already
      in `docs/INCIDENT_COMMS.md`):
      - Registration email delivery: 99 % within 5 min, 99.9 % within 1 h.
      - Per-session cert delivery: 99 % within 2 h.
      - Verify portal availability: 99.9 %.
      - Attendance credit: 99 % within 60 s of live chat post.
      Re-check monthly against actuals until the numbers stabilise.

## P2 — launch-month hardening

- [ ] **Poller edge-case tabletop** — 1 h session. Walk through:
      empty-page response, YouTube quota exhaustion, multiple live
      videos visible, zero-message finalize, partial R2 purge.
      Verify the code handles each gracefully. File issues for any
      gap, prioritise during first post-launch sprint.

- [ ] **Threat model v2** — re-run the initial codex threat model
      (documented in session brief) 30 days post-launch with real
      traffic patterns. Look for abuse signatures that didn't exist
      at launch time. Update rate-limit knobs accordingly.

- [x] **Preview environment with isolated bindings** — `sc-cpe-preview`
      D1, `sc-cpe-rate-preview` KV, `sc-cpe-certs-preview` R2 created.
      `[env.preview]` in `pages/wrangler.toml`. `deploy-preview.yml`
      workflow applies migrations + seed data on every PR. Completed
      2026-04-22.

## Verification: the "really launched" criteria

Before announcing publicly, confirm all of:
- [ ] `/status.html` — all five cron sources beating, no stale.
- [ ] Discord pipeline: a test watchdog run delivered.
- [ ] Email pipeline: a registration test flow end-to-end (reg → code
      → post in chat during a live briefing → credit appears → monthly
      cert arrives).
- [ ] Verify portal: download a real cert, drag into `/verify.html`,
      confirm SHA-256 match.
- [ ] Rollback rehearsed (above).
- [ ] FAQ, status, privacy, terms all linked from registration page.

Once all boxes are ticked, announcement is safe to fire.

## Owner

`ericrihm@gmail.com` is sole operator today. If that changes, update
this document AND `docs/RUNBOOK.md#owner` simultaneously — drift
between the two was the top source of confusion in prior incidents.
