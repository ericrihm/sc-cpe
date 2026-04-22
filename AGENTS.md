# AGENTS.md -- SC-CPE guidance for Codex and other AI agents

## System overview

CPE certificate issuance for Simply Cyber Daily Threat Briefing attendees.
Cloudflare Pages Functions (JS) + D1 (SQLite) + R2 + Workers. PAdES-T
signed PDF certs. Hash-chained append-only audit log. See CLAUDE.md for
full architecture and invariants.

## Build & test

```
bash scripts/test.sh              # node --test suite
bash scripts/smoke_hardening.sh   # read-only probes against deployed origin
python scripts/verify_audit_chain.py  # audit chain integrity
```

## Security invariants -- DO NOT violate

1. `audit_log` is append-only, hash-chained. Never UPDATE/DELETE rows.
2. `canonicalAuditRow()` must be byte-identical across JS, Python, Workers.
3. Admin endpoints use `Authorization: Bearer` -- no CSRF gates needed.
4. `/api/me/[token]/*` endpoints ARE CSRF-sensitive -- must call `isSameOrigin()`.
5. CSP: `script-src 'self'` -- no inline JS. External files only.
6. `dashboard_token` and `badge_token` are separate credentials.
7. Token expiry is 72h. Never extend.
8. Cert reissue: never UPDATE a generated cert -- always supersede.
9. Email sender cursor advances only on successful send.

## Security audit checklist

When reviewing for security, check ALL of these:

### Injection (OWASP A03)
- All D1 queries use parameterised `.bind()` -- no string concatenation
- User input in SQL: email, codes, tokens, pagination params
- No dynamic code execution of any kind (no string-to-code patterns)

### XSS (OWASP A07)
- All `innerHTML` uses `escapeHtml()` from `_lib.js`
- CSP `script-src 'self'` enforced in `_middleware.js`
- SVG badge endpoint sanitises all interpolated values

### Authentication & authorisation (OWASP A01)
- Admin endpoints: verify `isAdmin(request, env)` returns true
- Dashboard endpoints: verify token lookup + `isSameOrigin(request)`
- Token generation: `crypto.getRandomValues()` with 32 bytes
- Rate limiting: `rateLimit()` called on auth-sensitive endpoints

### CSRF
- `/api/me/[token]/*` must check `isSameOrigin()` -- Origin/Referer match
- Admin endpoints exempt (bearer token not auto-sent by browsers)

### Error handling & info leakage
- No stack traces in production responses
- Error responses use generic messages, not internal details
- 404 vs 403 -- avoid auth oracle

### Rate limiting
- Registration, login, recovery, resend-code, appeal endpoints
- Public APIs (leaderboard, links, badge)

### Audit log integrity
- Every state change writes an audit row
- `prev_hash` computed from `canonicalAuditRow(tip)`
- `UNIQUE INDEX audit_prev_hash_unique` serialises concurrent writers
- `ip_hash` lands in the `ip_hash` column (not `after_json`)

### CSP & headers
- Verify `_middleware.js` CSP covers all new resources
- HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy

## High-risk files for security review

- `pages/functions/_middleware.js` -- CSP, security headers
- `pages/functions/_lib.js` -- audit chain, crypto, rate limiting, auth
- `pages/functions/api/register.js` -- user registration
- `pages/functions/api/recover.js` -- account recovery
- `pages/functions/api/me/[token]/*.js` -- CSRF-sensitive dashboard
- `pages/functions/api/admin/*.js` -- bearer-token-gated admin ops
- `workers/poller/src/index.js` -- YouTube API, OAuth
- `workers/purge/src/index.js` -- cron: purge, digests, enrichment
- `services/certs/generate.py` -- PDF cert generation, PAdES signing

## Conventions

- Do not add comments unless WHY is non-obvious
- Do not create new files -- edit `_lib.js` for shared helpers
- Input validation at API boundaries only
- Commit style: `kind(scope): message`
- No inline JS (CSP enforced)
- No backwards-compat shims -- delete unused code
