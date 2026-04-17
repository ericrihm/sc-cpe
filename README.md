<p align="center">
  <img src="docs/assets/sample-cert.png" alt="SC-CPE Certificate Sample" width="520">
  <br/>
  <strong>SC-CPE</strong> — Simply Cyber CPE Certificates
  <br/>
  <em>Automatic, cryptographically verifiable continuing-education certificates<br/>for everyone who shows up to the Daily Threat Briefing.</em>
</p>

<p align="center">
  <a href="https://github.com/ericrihm/sc-cpe/actions/workflows/deploy-prod.yml"><img src="https://github.com/ericrihm/sc-cpe/actions/workflows/deploy-prod.yml/badge.svg?branch=main" alt="Deploy"></a>
  <a href="https://github.com/ericrihm/sc-cpe/actions/workflows/smoke.yml"><img src="https://github.com/ericrihm/sc-cpe/actions/workflows/smoke.yml/badge.svg" alt="Smoke"></a>
  <a href="https://github.com/ericrihm/sc-cpe/actions/workflows/ci.yml"><img src="https://github.com/ericrihm/sc-cpe/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://sc-cpe-web.pages.dev/status.html"><img src="https://img.shields.io/badge/status-live-brightgreen?style=flat" alt="Status: Live"></a>
  <a href="https://sc-cpe-web.pages.dev/verify.html"><img src="https://img.shields.io/badge/certs-PAdES--T%20signed-blue?style=flat" alt="PAdES-T Signed"></a>
</p>

**[See it in action: Verify a certificate](https://sc-cpe-web.pages.dev/verify.html)**

---

## What is this?

SC-CPE watches the [Simply Cyber Daily Threat Briefing](https://www.youtube.com/@simplycyber) YouTube live chat, matches per-user verification codes, and issues **signed PDF certificates** worth **0.5 CPE / CEU per session**. Every certificate is PAdES-T signed with an RFC-3161 timestamp and anchored to an append-only, hash-chained audit log — verifiable offline, years later, without contacting the issuer.

> [!TIP]
> 20 weekday briefings/month = **10 CPE**. Enough to cover a significant chunk of most annual renewal requirements.

---

## Supported Programs

| Program | Credit | Per Session | Submission Format |
|:--------|:-------|:------------|:------------------|
| **CompTIA** (Security+, CySA+, CASP+, PenTest+, Network+ ...) | CEU | 0.5 CEU | Proof-of-attendance: name, date(s), hours, provider, signature |
| **ISC2** (CISSP, SSCP, CCSP ...) | CPE | 0.5 CPE (Group B) | Same fields — upload under "Education" |
| **ISACA** (CISM, CISA, CRISC, CGEIT, CDPSE ...) | CPE | 0.5 CPE | All 7 ISACA audit-evidence fields present |

Acceptance is ultimately the certification body's decision — see [Terms §5](https://sc-cpe-web.pages.dev/terms.html#5).

> [!IMPORTANT]
> **ISACA 2027 update:** Starting January 2027, ISACA splits CPE into *certification-aligned* (90 CPE min) and *professional-aligned* (30 CPE max). The Daily Threat Briefing covers threats, risk management, security operations, and governance — all certification-aligned domains. SC-CPE certificates already include the activity description field needed for domain-relevance verification.

---

## Quickstart

```
1. Register    →  sc-cpe-web.pages.dev  (email + legal name + Turnstile)
2. Get code    →  check your email for SC-CPE{XXXX-XXXX}
3. Post code   →  paste it in YouTube live chat during the briefing
4. Get credit  →  shows on your dashboard within ~60 seconds
5. Get cert    →  per-session (~2h) or monthly bundle — your pick
```

Your dashboard link arrives by email from `certs@signalplane.co`. Bookmark it — it's your only credential.

---

## How It Works

```mermaid
flowchart LR
    subgraph User
        A([Register]) --> B([Get Code via Email])
        B --> C([Post Code in Live Chat])
    end

    subgraph SC-CPE Platform
        D[Poller Worker<br/>per-minute cron] -->|matches code| E[(Cloudflare D1<br/>SQLite)]
        F[Cert Signer<br/>Python + PAdES-T] -->|reads attendance| E
        F -->|signed PDF| G[R2 Storage]
        G --> H[Email Sender<br/>Worker]
    end

    subgraph External
        I{{YouTube Data API v3}} -->|live chat| D
        H -->|delivers cert| J{{Resend}}
        J --> K([User Inbox])
    end

    C -.->|visible in| I
    A -.->|creates row| E

    style D fill:#3b82f6,stroke:#1e40af,color:#fff
    style E fill:#10b981,stroke:#047857,color:#fff
    style F fill:#8b5cf6,stroke:#6d28d9,color:#fff
    style H fill:#f59e0b,stroke:#d97706,color:#fff
    style I fill:#ef4444,stroke:#b91c1c,color:#fff
    style J fill:#ec4899,stroke:#be185d,color:#fff
```

<details>
<summary><strong>Detailed data flow</strong></summary>

```
 1.  Register at /register.html
     → email + Turnstile. Dashboard link + SC-CPE{XXXX-XXXX} code arrive
       by email. The HTTP response never contains them — email possession
       is the activation gate.

 2.  Post your code in YouTube live chat during the stream.
     → The poller (every minute, 08:00-11:00 ET Mon-Fri) ingests chat,
       matches your code, and credits 0.5 CPE. Pre-stream chat and
       replays don't count. Dashboard tells you if you posted too early.

 3.  Pick cert style in the dashboard: per-session, bundled, or both.
     → Per-session certs arrive within ~2h. Bundled certs ship monthly.
       Both are PAdES-T signed.

 4.  Submit to your CE portal.
     → Upload the PDF under "webinars/seminars/training." The cert is
       the proof document.

 5.  Verify any cert at /verify.html
     → Drop the PDF on the page. SHA-256 is recomputed client-side and
       compared to the registered hash. Anyone — including auditors —
       can check without contacting us.
```

</details>

---

## Architecture

```mermaid
graph TB
    subgraph cf["Cloudflare Edge"]
        pages["Pages Functions<br/>API + UI"]
        d1[("D1 — SQLite<br/>schema.sql")]
        r2[("R2 — Object Storage<br/>chat JSON + signed PDFs")]

        subgraph workers["Workers (cron-triggered)"]
            poller["Poller<br/>⏱ per-minute<br/>ET 08-11 M-F"]
            email["Email Sender<br/>⏱ every 2 min"]
            purge["Purge + Digests<br/>⏱ daily 09:00 UTC"]
        end
    end

    subgraph ext["External Services"]
        yt["YouTube Data API v3"]
        resend["Resend<br/>certs@signalplane.co"]
        tsa["RFC-3161 TSA"]
    end

    subgraph gh["GitHub Actions"]
        ci["CI: tests + gitleaks"]
        deploy["deploy-prod"]
        smoke["Hourly smoke canary"]
        watchdog["15-min watchdog"]
        certs["Cert signer cron<br/>Python + WeasyPrint"]
        schema["Weekly schema drift"]
    end

    yt -->|liveChatMessages| poller
    poller -->|attendance rows| d1
    pages --> d1
    pages --> r2
    certs -->|signed PDFs| r2
    certs -->|queues email| d1
    email -->|drains outbox| resend
    purge -->|chat GC| r2
    purge -->|digests| d1
    certs -->|timestamp| tsa
    deploy -->|wrangler| cf
    smoke -->|/api/health| pages
    watchdog -->|/api/health| pages

    style d1 fill:#10b981,stroke:#047857,color:#fff
    style r2 fill:#06b6d4,stroke:#0e7490,color:#fff
    style poller fill:#3b82f6,stroke:#1e40af,color:#fff
    style email fill:#f59e0b,stroke:#d97706,color:#fff
    style purge fill:#a855f7,stroke:#7c3aed,color:#fff
    style certs fill:#8b5cf6,stroke:#6d28d9,color:#fff
    style yt fill:#ef4444,stroke:#b91c1c,color:#fff
```

### Components

| Component | Tech | What it does |
|:----------|:-----|:-------------|
| **Pages Functions** | Cloudflare Pages | Registration, dashboard, verify, admin API |
| **Poller** | CF Worker (cron) | Polls YouTube live chat, matches codes, credits attendance |
| **Email Sender** | CF Worker (cron) | Drains `email_outbox` via Resend |
| **Purge** | CF Worker (cron) | Daily R2 chat GC + security digest + weekly digest + cert nudge |
| **Cert Signer** | Python 3.11 (GH Actions) | WeasyPrint render + `endesive` PAdES-T with RFC-3161 |
| **D1** | Cloudflare SQLite | Single source of truth — schema in `db/schema.sql` |
| **R2** | Cloudflare Object Storage | Raw chat JSONL (purges daily) + signed PDF certs |

---

## Certificate Integrity

> [!NOTE]
> Anyone can generate a PDF that says "attended." SC-CPE certificates are different because each one is anchored to four independent, durable pieces of evidence.

<table>
<tr>
<td width="50%">

**1. Time-gated attendance**

The poller only credits messages whose YouTube `publishedAt` falls inside the live window. Pre-stream chat and replays don't count. Rejected attempts are logged and surfaced on your dashboard.

**2. Hash-chained audit log**

Every state transition is recorded in an append-only, SHA-256 chained table with a `UNIQUE INDEX` on `prev_hash`. Chain forks fail at insert time. `verify_audit_chain.py` replays the full chain.

</td>
<td width="50%">

**3. PAdES-T + RFC-3161**

Certs are signed with a dedicated CA-rooted key and bound to a trusted timestamp authority. The signature outlives the key's validity period. The signing cert fingerprint is on the face of every PDF.

**4. Public verify URL**

Each cert carries a `/verify.html?t=...` link anyone can open — no login required. Drop the PDF on the page and the browser recomputes its SHA-256 client-side against the registered hash.

</td>
</tr>
</table>

```
user_registered → code_matched → attendance_credited → cert_issued → email_sent
       ▲                                                      ▲
       └──────── prev_hash = sha256(canonicalAuditRow(tip)) ──┘
```

---

## Cert Delivery Options

| Option | Best for | Delivery |
|:-------|:---------|:---------|
| **Per-session** | CompTIA (1 activity per submission) | On demand, ~2h after request |
| **Monthly bundle** | ISC2 / ISACA (annual rollup) | Auto-generated end of month |
| **Both** | Multiple certifications | Per-session + monthly |

Change your preference anytime from the dashboard.

---

## Observability

| Signal | Source | Cadence |
|:-------|:-------|:--------|
| Poller heartbeat | D1 `heartbeats` | Every minute (during stream window) |
| Purge / security alerts / digest / cert nudge | D1 `heartbeats` | Daily / weekly / monthly |
| Email sender | D1 `heartbeats` | Every run |
| Synthetic canary | GH Actions `smoke.yml` | Hourly — pings prod, writes canary heartbeat |
| Watchdog | GH Actions `watchdog.yml` | 15-min `/api/health` poll, Discord alerts |
| Audit chain | `/api/admin/audit-chain-verify` | On-demand full walk |
| Schema drift | GH Actions `schema-drift.yml` | Weekly D1-vs-`schema.sql` diff |

Live status: [`/status.html`](https://sc-cpe-web.pages.dev/status.html) (auto-refreshes every 30s)

---

<details>
<summary><strong>API Surface</strong></summary>

| Path | Auth | Purpose |
|:-----|:-----|:--------|
| `POST /api/register` | Turnstile | Sign up |
| `GET /api/me/{token}` | dashboard-token | User view |
| `POST /api/me/{token}/cert-feedback` | dashboard-token + CSRF | Report typo/error |
| `POST /api/me/{token}/prefs` | dashboard-token + CSRF | Set cert style, nudge opt-out |
| `POST /api/me/{token}/cert-per-session/{stream_id}` | dashboard-token + CSRF | Request single-session cert |
| `POST /api/me/{token}/resend-code` | dashboard-token + CSRF | Get a fresh verification code |
| `POST /api/me/{token}/delete` | dashboard-token + CSRF | Account deletion |
| `POST /api/me/{token}/recover` | Turnstile | Email dashboard link recovery |
| `GET /api/health` | public | External watchdog poll |
| `GET /api/verify/{token}` | public | Cert verification data |
| `GET /api/crl.json` | public | Certificate revocation list |
| `GET /api/admin/heartbeat-status` | bearer | Per-source staleness |
| `GET /api/admin/audit-chain-verify` | bearer | Full chain walk |
| `GET /api/admin/ops-stats` | bearer | Dashboard counts |
| `GET /api/admin/cert-feedback` | bearer | Non-ok feedback inbox |
| `POST /api/admin/cert/{id}/reissue` | bearer | Queue cert regeneration |
| `POST /api/admin/canary-beat` | bearer | Hourly smoke heartbeat |

</details>

---

## Who Runs This

**Simply Cyber LLC** (United States). Fully open-source at [`github.com/ericrihm/sc-cpe`](https://github.com/ericrihm/sc-cpe) — every line that decides who gets credit, every policy doc, every deploy workflow. Branch protection + required CI + auto-deploy means the deployed code is the exact SHA on `main`.

| Domain | Purpose |
|:-------|:--------|
| `sc-cpe-web.pages.dev` | Web + API (canonical origin) |
| `cpe.simplycyber.io` | Reserved — future DNS wiring |
| `signalplane.co` | Email domain (DKIM + SPF + DMARC) |

Security disclosure: [`security.txt`](https://sc-cpe-web.pages.dev/.well-known/security.txt) or email `certs@signalplane.co` with `[SECURITY]` in the subject.

---

## Development

```bash
scripts/install_hooks.sh                 # pre-push hook → runs test suite
bash scripts/test.sh                     # pure-logic tests
scripts/check_schema.sh                  # diff live D1 schema vs repo
ADMIN_TOKEN=... ORIGIN=https://sc-cpe-web.pages.dev \
  scripts/smoke_hardening.sh             # read-only probe of deployed origin
```

## Deploying

Auto-deploy on every merge to `main` via [`deploy-prod.yml`](.github/workflows/deploy-prod.yml):
tests → Pages → Workers (parallel) → post-deploy smoke. ~2 min on a warm runner.

```bash
git checkout -b fix/whatever
git commit -m "fix(scope): description"
git push -u origin fix/whatever
gh pr create --fill && gh pr merge --auto --squash
```

> [!CAUTION]
> **Break-glass only:** `enforce_admins: false` allows admin direct-push to `main`. The push trigger still fires `deploy-prod` with full test suite. Re-engage protection immediately after.

---

## Repo Map

```
pages/                 Cloudflare Pages Functions — public web surface
  functions/api/       JSON API (register, dashboard, admin, verify)
  _lib.js              Shared helpers (audit, rate-limit, email, crypto)
workers/
  poller/              Per-minute livestream chat poller
  purge/               Daily R2 chat GC + security/weekly digests
  email-sender/        Drains email_outbox via Resend
services/certs/        Python PDF issuer (PAdES-T + RFC-3161)
db/
  schema.sql           Authoritative schema
  migrations/          Append-only numbered migrations
scripts/               Smoke, schema check, audit verifier, tests
.github/workflows/     CI, deploy, smoke, watchdog, cert crons, schema drift
docs/
  RUNBOOK.md           Operator procedures
  LTV.md               Legal/compliance reasoning (GDPR Art. 17(3)(e))
  VERIFIER_GUIDE.md    Third-party cert verification guide
```

## Community

Built for the [Simply Cyber](https://www.youtube.com/@SimplyCyber) community.
Found a bug or have feedback? [Open an issue](https://github.com/ericrihm/sc-cpe/issues) or email certs@signalplane.co.

## License

MIT — see [LICENSE](LICENSE) for details. Cert artefacts are retained under GDPR Art. 17(3)(e) as evidentiary records.
