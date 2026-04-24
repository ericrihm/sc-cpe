# Developer Environment Setup

## Prerequisites

- **Node.js 18+** — test suite uses `node --test` (built-in runner)
- **Python 3.10+** — cert generator (`services/certs/generate.py`)
- **wrangler CLI** — `npm i -g wrangler` for local Pages/Workers dev
- **git** — repo uses `.githooks/pre-push` (runs test suite)

## Clone and install

```bash
git clone https://github.com/<org>/sc-cpe.git
cd sc-cpe
```

No `npm install` needed — the project has zero Node dependencies. All
tests use `node:test` and `node:assert` (stdlib). The Python cert
generator has its own requirements in `services/certs/requirements.txt`.

## Running tests

```bash
bash scripts/test.sh
```

This runs every `*.test.mjs` file listed in `scripts/test.sh`. New test
files must be added to that script manually (no auto-discovery). The
`.githooks/pre-push` hook runs the same suite before every push.

## Smoke tests (deployed origin)

```bash
ADMIN_TOKEN="$(tr -d '\n' < ~/.cloudflare/sc-cpe-admin-token)" \
  ORIGIN="https://sc-cpe-web.pages.dev" scripts/smoke_hardening.sh
```

Read-only probes against the deployed site. Safe to run anytime.

## Schema drift check

```bash
bash scripts/check_schema.sh
```

Compares live D1 schema against `db/schema.sql`. Requires
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` env vars.

## Preview environment

The repo has a full preview environment configured in `wrangler.toml`
under `[env.preview]`:

| Resource | Preview binding |
|----------|----------------|
| D1 | `sc-cpe-preview` (`8aa974e0-...`) |
| KV | `sc-cpe-rate-preview` (`3eecd067...`) |
| R2 | `sc-cpe-certs-preview` |

PR deployments use these bindings via `.github/workflows/deploy-preview.yml`.
Preview D1 is independent of production — safe for schema experiments.

## Local development with wrangler

```bash
cd pages
wrangler pages dev .
```

For local secrets, create `pages/.dev.vars`:

```
ADMIN_TOKEN=your-local-dev-token
YOUTUBE_API_KEY=your-api-key
RESEND_API_KEY=re_test_...
```

Workers run independently:

```bash
cd workers/poller && wrangler dev
cd workers/purge && wrangler dev
cd workers/email-sender && wrangler dev
```

## Python cert generator

```bash
cd services/certs
python3 -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
```

Run locally (requires D1 API access + signing key):

```bash
python generate.py --pending-only  # drain pending certs
python generate.py                 # full monthly sweep
```

## Audit chain verification

```bash
python scripts/verify_audit_chain.py
```

Checks hash-chain integrity via D1 HTTP API. Requires CF API token.

## Common issues

**CRLF warnings on Windows**: Git may warn about LF→CRLF conversion.
This is cosmetic — the CI runs on Linux. To silence:

```bash
git config core.autocrlf input
```

**Python venv on Windows**: Use `.venv\Scripts\activate` instead of
`source .venv/bin/activate`. If `pip install` fails for `cryptography`,
install the Rust toolchain or use `pip install --only-binary=:all:`.

**Pre-push hook not firing**: Ensure the hook is executable and git is
configured to use the repo's hooks directory:

```bash
git config core.hooksPath .githooks
chmod +x .githooks/pre-push
```

## Architecture context

See `CLAUDE.md` for invariants, deployment details, and known gaps.
See `docs/DESIGN.md` for architecture decisions.
