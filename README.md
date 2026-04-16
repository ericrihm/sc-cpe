# SC‑CPE — Simply Cyber CPE Certificates

**Get credit for watching the daily briefing.** Automatic, cryptographically
verifiable continuing‑education certificates for everyone who shows up to the
[Simply Cyber Daily Threat Briefing](https://www.youtube.com/@simplycyber).

Works for the programs most of the community is renewing:

| Program | Credit unit | Per session | This cert satisfies |
| --- | --- | --- | --- |
| **CompTIA** (Security+, CySA+, Network+, PenTest+, CASP+ …) | **CEU** | **0.5 CEU** | Proof of attendance for the CE portal — name, date(s), hours, provider, signature |
| **ISC2** (CISSP, SSCP, CCSP, …) | CPE | 0.5 CPE (Group B) | Ditto — upload under "Education" |
| **ISACA** (CISM, CISA, CRISC, …) | CPE | 0.5 CPE | Ditto — "group training / web‑based" |

Attend the livestream → post your per‑user code in chat → get a signed
PDF certificate **per session, per month, or both**. Every step is
hash‑chained and independently auditable years later without trusting
the issuer.

> **Status:** in production on Cloudflare. Smoke green, audit chain intact,
> five fresh heartbeats, hourly synthetic canary.
> Live at **https://sc-cpe-web.pages.dev**.

---

## Who runs this, and why trust it

A CPE cert is only as good as the entity behind it. Three quick answers for
the skeptical (which is most of this community, appropriately):

- **Operator.** Simply Cyber LLC (United States). The source for this service
  is public at [github.com/ericrihm/sc-cpe](https://github.com/ericrihm/sc-cpe)
  — every line that decides who gets credit, every policy doc, every
  deploy workflow. Branch protection + required CI + auto‑deploy means the
  deployed bundle is the exact SHA you see on GitHub `main`.
- **Domains.** You'll see three. The web + API live at
  [sc-cpe-web.pages.dev](https://sc-cpe-web.pages.dev) (apex
  `cpe.simplycyber.io` is reserved for future DNS wiring — until that lands,
  `sc-cpe-web.pages.dev` is the canonical origin). Email (registration
  codes, cert delivery, recovery, revocation notices) ships from
  `certs@signalplane.co` via Resend, DKIM + SPF aligned with DMARC in
  place; `signalplane.co` is the operator's verified email domain and hosts
  the monitored `contact@`, `privacy@`, `security@` inboxes.
- **Certificate integrity.** Each PDF is PAdES‑T signed with a dedicated
  code‑signing key whose public fingerprint is printed on the cert
  itself. The RFC‑3161 timestamp means the signature survives key
  expiry. You can verify without talking to us: the
  [verify portal](https://sc-cpe-web.pages.dev/verify.html) shows the
  registered SHA‑256 and lets you drop the PDF in to compare client‑side,
  or inspect the signature in any PAdES‑aware PDF reader.
- **Audit integrity.** Every state transition — registration, attendance
  credit, cert issue, delivery, revocation — writes an append‑only,
  SHA‑256 hash‑chained row. `scripts/verify_audit_chain.py` replays the
  whole chain against the live DB; a `UNIQUE INDEX` on `prev_hash` makes
  forks structurally impossible.
- **Security disclosure.** See
  [security.txt](https://sc-cpe-web.pages.dev/.well-known/security.txt)
  or email `certs@signalplane.co` with `[SECURITY]` in the subject.
  3‑day acknowledgement, 7‑day triage, 30‑day fix plan for P0/P1
  findings. (All operator inbound mail goes to a single inbox at
  launch; see [Privacy §13](https://sc-cpe-web.pages.dev/privacy.html#13)
  for the full `[SECURITY]` / `[PRIVACY]` / `[ACCOUNT]` / `[CERT]`
  prefix scheme.)
- **Live service health.** [`/status.html`](https://sc-cpe-web.pages.dev/status.html)
  auto‑refreshes every 30s from `/api/health` and shows per‑cron
  staleness in plain English; [`/faq.html`](https://sc-cpe-web.pages.dev/faq.html)
  covers the common operational questions (missing credits, email
  delays, verification for CE‑portal auditors).

---

## What the certificate looks like

![Sample SC‑CPE certificate of attendance](docs/assets/sample-cert.png)

> Sample — `Jane Doe`, 12 sessions × 0.5 = **6 CEU / CPE** for the month.
> [Download the full PDF](docs/assets/sample-cert.pdf) at print resolution.
> Real certs are PAdES‑T signed with an RFC‑3161 timestamp and anchored to
> an append‑only audit chain.

Everything a CompTIA CE Portal submission (or ISC2 / ISACA upload) asks for
is on the face of the document: **recipient name, issuer, activity title,
date(s) attended, hours earned, signature, and a public verify URL + QR**.

## Two ways to get your cert

You pick in the dashboard — change it any time.

- **Per‑session (recommended for CompTIA).** One signed PDF per briefing
  you attended. CompTIA's CE portal logs one activity per submission, so
  per‑session certs paste in cleanly. Request them on demand from the
  dashboard; they're signed within 2 hours.
- **Monthly bundled (recommended for ISC2 / ISACA).** One PDF listing
  every session that month with a single hours total. Easier to attach
  to an annual rollup than 20 individual certs.
- **Both.** You'll get per‑session + monthly bundled. Useful if you
  maintain multiple certifications.

---

## Why it exists

Continuing‑education credit is one of the main reasons professionals block
off time for the daily briefing, but tracking attendance and issuing certs
by hand doesn't scale past a few dozen people. SC‑CPE does it end‑to‑end:

- **Zero manual ops.** A poller watches the YouTube live chat, a monthly
  cron issues PDFs, a Worker drains the outbox.
- **Verifiable without us.** Each cert carries an RFC‑3161 timestamp and a
  hash‑chained audit trail. If Simply Cyber vanished tomorrow, an
  auditor could still confirm every cert was issued when and to whom we
  claim — using only the cert, the signing public cert, and the published
  audit chain hash.
- **Private by default.** Chat logs purge daily (capped + resumable so a
  flooded prefix can't stall the worker). PII never leaves Cloudflare.
  The append‑only audit log writes only hashes, enums, and counts —
  never raw emails, admin free‑text reasons, or search queries — so
  account deletion remains meaningful years after the fact. Dashboard
  tokens are per‑user; admin endpoints use bearer tokens (CSRF‑immune
  by construction).
- **Small, boring, cheap.** Single D1 database, three Workers, one Pages
  site. Estimated at cents/month for the expected volume.

---

## How attendance → certificate works

```
 1.  Register at  /register.html
     → one‑time sign‑up with email + Turnstile. Your dashboard link and
       personal 6‑char chat code are emailed to the address you entered —
       the HTTP response never contains them, so email possession is the
       only activation gate (a Turnstile‑solver who knows your address
       cannot hijack the registration).

 2.  Watch the stream and post your code in YouTube live chat.
     → The poller (runs every minute, 08:00‑11:00 ET Mon–Fri) ingests
       the chat, matches your code to your user row, and credits
       0.5 CEU / CPE for that session. The code must be posted *during*
       the live window — pre‑stream chat and replays don't count, and
       the dashboard tells you if you posted too early.

 3.  Pick per‑session, bundled, or both in the dashboard.
     → Per‑session certs arrive within ~2h of request. Bundled certs
       ship once a month. Both are PAdES‑T signed and emailed via Resend.

 4.  Submit to your CE portal.
     → Upload the PDF under "Attending webinars/seminars/training" (or
       your program's equivalent). The cert itself is the proof document.

 5.  Verify any cert anytime.
     → /verify.html?t=PUBLIC_TOKEN returns the recipient, sessions,
       and audit chain position. Drop the PDF onto the page in step 2
       and the browser recomputes its SHA‑256 client‑side and compares
       to the registered hash — a lookalike PDF with a leaked token
       fails the match. Anyone — including your CE auditor — can check
       without talking to us; the file never leaves the browser.
```

**0.5 CEU / CPE per 30‑minute session** · up to ~20 sessions/month · per‑session
or bundled (or both) · full reissue flow if your name or email is wrong.

Your YouTube channel auto‑links the first time the poller matches your code in
a live briefing chat. If credits are granted manually (admin reconciliation —
e.g. the poller missed a briefing), the channel stays unlinked until your next
auto‑matched post. The dashboard shows this state honestly rather than implying
you haven't posted yet.

---

## Why this cert is authentic

Anyone can print a PDF that says "attended." What separates SC‑CPE from a
fill‑in template is that every cert is anchored to four independent pieces
of evidence that survive long after the session ended:

1. **Time‑gated attendance.** The poller only credits messages whose
   YouTube `publishedAt` timestamp falls inside the live window
   (`actual_start_at` ± configured grace). Posting your code in the
   pre‑stream chat or the next day's replay does *not* earn credit, and
   the attempt is written to the audit log — so the "attended live"
   claim on the cert is structurally defensible. Rejected messages
   surface back on your dashboard with the exact timestamp we saw and
   the window that was open, so you always know why credit didn't land.
2. **Hash‑chained audit log.** Every state transition from registration
   through cert delivery is recorded in an append‑only, SHA‑256 chained
   table. A `UNIQUE INDEX` on `prev_hash` makes forks structurally
   impossible. `scripts/verify_audit_chain.py` replays the whole chain
   against the live database.
3. **PAdES‑T signature + RFC‑3161 timestamp.** Certs are signed with a
   dedicated CA‑rooted code‑signing key and bound to a trusted timestamp
   authority, so the signature outlives the signing key's validity
   period. The signing cert's SHA‑256 fingerprint is stamped on the face
   of the PDF.
4. **Public verify URL + QR.** Each cert carries a `/verify.html?t=…`
   link auditors can open directly — no SC‑CPE login required — which
   recomputes the PDF hash, shows the audit‑chain position, and returns
   the session evidence (first message id, first message SHA‑256,
   rule version).

The underlying attendance row records `first_msg_id` and `first_msg_sha256`
— retrievable via the verify URL — so an auditor can cross‑reference the
cert against YouTube's own liveChatMessages record.

---

## Trust model

Every state change writes a row to `audit_log`. Each row includes the
SHA‑256 of its predecessor — a classic hash chain. A `UNIQUE INDEX` on
`prev_hash` serialises concurrent writers, so forks are structurally
impossible.

```
user_registered → code_matched → attendance_credited → cert_issued → email_sent
       ▲                                                     ▲
       └──────── prev_hash = sha256(canonicalAuditRow(tip)) ─┘
```

- `scripts/verify_audit_chain.py` walks the entire chain end‑to‑end against
  the D1 HTTP API. Last run: 22 rows, unique index present, no breaks.
- `scripts/test_chain_parity.mjs` guards that the canonical‑row function
  is byte‑identical across JS (Pages Functions + Workers) and Python
  (cert signer + verifier). Any divergence breaks CI immediately.
- Certs are signed with a dedicated CA‑rooted code‑signing key; the
  public cert fingerprint is embedded on the PDF itself so a verifier
  doesn't need our help to check a signature.

---

## Architecture

```
                    ┌─────────────────────────────┐
 YouTube live chat  │  Workers / poller           │  per‑minute, ET 08‑11 Mon–Fri
 ──────────────────►│  matches codes → D1         │
                    └──────────────┬──────────────┘
                                   │
┌──────────────┐                   ▼
│ Pages        │        ┌─────────────────────┐
│ Functions    │───────►│  Cloudflare D1      │  schema: db/schema.sql
│ (API + UI)   │        │  (authoritative)    │  append‑only audit_log
└──────┬───────┘        └────────┬────────────┘
       │                         │
       │                         ▼
       │               ┌─────────────────────┐
       │   monthly     │  services/certs     │  Python · WeasyPrint · endesive
       └──────────────►│  PDF + PAdES‑T sign │  → R2 + email_outbox
                       └────────┬────────────┘
                                │
                       ┌────────▼────────────┐      ┌──────────────────────┐
                       │  Workers / email‑   │─────►│  Resend              │
                       │  sender (drains     │      │  certs@signalplane.co│
                       │  email_outbox)      │      └──────────────────────┘
                       └────────┬────────────┘
                                │
                       ┌────────▼────────────┐
                       │  Workers / purge    │  daily 09:00 UTC
                       │  R2 chat GC +       │  security digest, weekly
                       │  digests + nudges   │  digest, cert‑feedback nudge
                       └─────────────────────┘
```

- **Frontend + API:** Cloudflare Pages Functions (`pages/`)
- **DB:** Cloudflare D1 (SQLite) — `db/schema.sql` is authoritative, migrations in `db/migrations/`
- **Storage:** R2 for raw chat JSON + signed PDFs (chat purges daily)
- **Email:** Resend from `certs@signalplane.co` (DKIM + SPF aligned)
- **Cert signing:** Python 3.11, WeasyPrint render, `endesive` PAdES‑T with RFC‑3161 timestamp

---

## Observability

| Signal | Where | Cadence |
| --- | --- | --- |
| `poller` heartbeat | D1 `heartbeats` | every minute during stream window |
| `purge` / `security_alerts` / `weekly_digest` / `cert_nudge` | D1 `heartbeats` | daily / weekly / monthly |
| `email_sender` heartbeat | D1 `heartbeats` | every run |
| Synthetic canary | GH Actions `smoke.yml` | hourly, pings prod, writes `canary` heartbeat |
| Watchdog | GH Actions `watchdog.yml` | 15‑minute `/api/health` poll, Discord alerts with dedup |
| Audit chain | `/api/admin/audit-chain-verify` | on‑demand, full walk + unique‑index assertion |
| Schema drift | GH Actions `schema-drift.yml` | weekly D1‑vs‑`schema.sql` diff |

Admins can trigger any cron block immediately without waiting for its
schedule:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  -X POST "https://sc-cpe-purge.ericrihm.workers.dev/?only=cert_nudge"
# only ∈ purge | security_alerts | weekly_digest | cert_nudge | all
```

---

## Key endpoints

<details>
<summary>Full API surface</summary>

| Path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/register` | Turnstile | Sign‑up |
| `GET /api/me/{token}` | dashboard‑token | User view |
| `POST /api/me/{token}/cert-feedback` | dashboard‑token + CSRF | Report typo/wrong |
| `POST /api/me/{token}/prefs` | dashboard‑token + CSRF | Set `cert_style` (bundled / per_session / both), nudge opt‑out |
| `POST /api/me/{token}/cert-per-session/{stream_id}` | dashboard‑token + CSRF | Request single‑session cert (idempotent) |
| `GET /api/health` | public | External watchdog poll |
| `GET /api/admin/heartbeat-status` | bearer | Per‑source staleness |
| `GET /api/admin/audit-chain-verify` | bearer | Full chain walk |
| `GET /api/admin/ops-stats` | bearer | Dashboard counts |
| `GET /api/admin/cert-feedback` | bearer | Non‑ok cert‑feedback inbox |
| `POST /api/admin/cert/{id}/reissue` | bearer | Queue regenerated cert (supersedes chain) |
| `POST /api/admin/canary-beat` | bearer | Hourly smoke heartbeat |

Pages:

- `/dashboard.html?t=TOKEN` — user dashboard (attendance, certs, feedback)
- `/admin.html` — operator dashboard (paste `ADMIN_TOKEN` in‑page)
- `/verify.html?t=PUBLIC_TOKEN` — public cert verification

</details>

---

## Developing

Prerequisites: Node 20+, Python 3.11+, `wrangler` logged in.

```bash
scripts/install_hooks.sh                 # git hooks — runs test suite pre‑push
bash scripts/test.sh                     # pure‑logic tests (93/93 currently)
scripts/check_schema.sh                  # diff live D1 schema vs repo
ADMIN_TOKEN=... ORIGIN=https://sc-cpe-web.pages.dev \
  scripts/smoke_hardening.sh             # read‑only probe of deployed origin
```

Regenerate the sample cert used in this README:

```bash
python3 -m venv .venv-sample
.venv-sample/bin/pip install -r services/certs/requirements.txt pymupdf
.venv-sample/bin/python scripts/generate_sample_cert.py
```

## Deploying

Pages + Workers ship automatically on every merge to `main` via
[`.github/workflows/deploy-prod.yml`](.github/workflows/deploy-prod.yml):
tests → Pages → Workers (`purge`, `poller`, `email-sender` in parallel) →
post‑deploy hardening smoke. End‑to‑end ~2 min on a warm runner.

`main` is branch‑protected: merges require a PR with `Node test suite`
and `Secret scan (gitleaks)` green, no force‑push, no direct commits
(admin break‑glass is available via `enforce_admins: false`). Auto‑merge
is on — open a PR and `gh pr merge --auto --squash` lands it the moment
CI goes green, triggering the deploy.

Typical change flow:

```bash
git checkout -b fix/whatever
# ...edit...
git commit -m "fix(x): thing"
git push -u origin fix/whatever
gh pr create --fill
gh pr merge --auto --squash
```

The Python cert cron (`services/certs/generate.py`) runs on its own
schedule in `.github/workflows/{monthly-certs,cert-sign-pending}.yml`,
independent of the web deploy.

The hourly `smoke.yml` canary keeps running between deploys as an
ongoing health probe — it doubles the coverage that `deploy-prod`'s
post‑deploy smoke provides at release time.

**Break-glass direct deploy** (rare: signing infra regression, CI-blocking
bug). `enforce_admins: false` means admin pushes to `main` bypass the PR
gate, and the push trigger still fires `deploy-prod`. Prefer toggling
protection off in Settings → Branches if the emergency is that CI itself
is red — otherwise just fix-and-push. Re-engage protection immediately
after.

---

## Repo map

- `CLAUDE.md` — working notes, invariants, conventions
- `docs/RUNBOOK.md` — operator procedures
- `docs/LTV.md` — legal/compliance reasoning (GDPR Art. 17(3)(e) carve‑out)
- `outputs/handoffs/` — session‑end briefs
- `scripts/generate_sample_cert.py` — regenerates `docs/assets/sample-cert.{pdf,png}`

## License

Internal. All rights reserved. Cert artefacts are retained under
GDPR Art. 17(3)(e) as evidentiary records
(see `pages/functions/api/me/[token]/delete.js`).
