# SC-CPE API Reference

All endpoints are served from the Cloudflare Pages Functions at `pages/functions/api/`.

**Auth schemes**

| Scheme | How |
|--------|-----|
| Public | No authentication |
| Bearer | `Authorization: Bearer <ADMIN_TOKEN>` header |
| Dashboard token | Token embedded in URL path: `/api/me/{token}/...` |
| Watchdog secret | `X-Watchdog-Secret: <WATCHDOG_SECRET>` header |

**CSRF notes** — Dashboard-token endpoints that mutate state require `isSameOrigin()` (checks `Origin` or `Referer` header against the Pages origin). Admin bearer-token endpoints are CSRF-immune by construction (browsers do not auto-send `Authorization` cross-origin).

---

## 1. Public endpoints

### `GET /api/health`

Liveness check. Polls every heartbeat source and classifies staleness.

**Auth:** none

**Response**

```json
{
  "now": "ISO8601",
  "poll_window_active": true,
  "any_stale": false,
  "sources": [
    {
      "source": "poller",
      "last_beat_at": "ISO8601",
      "last_status": "ok",
      "age_seconds": 42,
      "expected": true,
      "stale": false,
      "threshold_seconds": 240
    }
  ]
}
```

---

### `GET /api/verify/{token}`

Verify a CPE certificate by its public token (32–128 hex chars).

**Auth:** none  
**Rate limit:** 120 req/hr per IP

**Response (valid)**

```json
{
  "valid": true,
  "state": "generated",
  "issuer": "Simply Cyber LLC",
  "recipient": "Jane Smith",
  "activity_title": "Simply Cyber Daily Threat Briefing",
  "activity_description": "...",
  "period_yyyymm": "202603",
  "period_start": "2026-03-01",
  "period_end": "2026-03-31",
  "cpe_total": 5.0,
  "sessions_count": 10,
  "signing_cert_sha256": "...",
  "pdf_sha256": "...",
  "issued_at": "ISO8601"
}
```

Adds `revoked_at` and `revocation_reason` (opaque enum) when `state` is `revoked`. Returns `{ "valid": false }` with 404 if not found.

Side effect: sets `certs.first_viewed_at` on first call, writes audit row `cert_verified`.

---

### `GET /api/leaderboard`

Public opt-in leaderboard for the current calendar month (top 20).

**Auth:** none  
**Rate limit:** 120 req/hr per IP

**Response**

```json
{
  "period": "202604",
  "entries": [
    { "rank": 1, "display_name": "Jane S.", "cpe_earned": 8.0, "sessions": 16, "streak": 12 }
  ]
}
```

Only users with `show_on_leaderboard = 1` appear. Names are abbreviated to `First L.`.

---

### `GET /api/links`

Show links archive — URLs shared by host/moderators during livestreams.

**Auth:** none  
**Rate limit:** 120 req/hr per IP

**Query params**

| Param | Default | Description |
|-------|---------|-------------|
| `date` | most recent date with links | `YYYY-MM-DD` |
| `limit` | 30 | 1–30 |
| `offset` | 0 | pagination |

**Response**

```json
{
  "date": "2026-04-22",
  "stream": { "title": "...", "yt_video_id": "..." },
  "links": [
    { "url": "...", "domain": "...", "title": "...", "description": "...", "author_type": "owner", "author_name": "...", "posted_at": "ISO8601" }
  ],
  "available_dates": ["2026-04-22", "..."],
  "date_link_counts": { "2026-04-22": 5 }
}
```

---

### `GET /api/links/rss`

RSS 2.0 feed of show links, last 30 days with links.

**Auth:** none  
**Rate limit:** 60 req/hr per IP  
**Content-Type:** `application/rss+xml; charset=utf-8`  
**Cache-Control:** `public, max-age=3600`

---

### `GET /api/badge/{token}`

SVG attendance badge. Token is `users.badge_token` (not `dashboard_token`).

**Auth:** none  
**Rate limit:** 300 req/hr per IP  
**Content-Type:** `image/svg+xml`  
**Cache-Control:** `public, max-age=3600`

Returns a 480×260 SVG showing name, total CPE, streak, and session count.

---

### `GET /api/profile/{token}`

Public profile JSON. Token is `users.badge_token`.

**Auth:** none  
**Rate limit:** 120 req/hr per IP

**Response**

```json
{
  "display_name": "Jane S.",
  "member_since": "ISO8601",
  "total_cpe": 22.0,
  "total_sessions": 44,
  "certs_earned": 3,
  "current_streak": 7,
  "longest_streak": 21
}
```

---

### `GET /api/download/{token}`

Download a signed PDF certificate. Token is `certs.public_token`.

**Auth:** none (possession of public_token is the auth bar)  
**Rate limit:** 60 req/hr per IP  
**Content-Type:** `application/pdf`  
**Content-Disposition:** `attachment; filename="sc-cpe-YYYYMM-{name}.pdf"`

Returns 410 if revoked or regenerated, or if SHA-256 integrity check fails. Writes audit row `cert_downloaded`.

---

### `GET /api/crl.json`

Public Certificate Revocation List.

**Auth:** none  
**Cache-Control:** `public, max-age=300`  
**CORS:** `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`

**Response**

```json
{
  "generated_at": "ISO8601",
  "count": 2,
  "revoked": [
    { "public_token": "...", "revoked_at": "ISO8601", "reason": "superseded", "period_yyyymm": "202603" }
  ]
}
```

`reason` is an opaque enum: `issued_in_error` | `superseded` | `subject_request` | `key_compromise` | `other`.

---

### `POST /api/csp-report`

Content Security Policy violation receiver (browser-native endpoint).

**Auth:** none  
**Rate limit:** 100 reports/hr per IP (silent drop after limit)  
**Response:** `204 No Content`

Accepts both old (`csp-report`) and new (`blockedURL`) report formats. Stores up to 50 entries per hour bucket in KV; increments `sec:csp_violation:{hour}` counter.

---

### `POST /api/email-webhook`

Resend webhook receiver for bounce and complaint events.

**Auth:** Svix HMAC signature (`svix-id`, `svix-timestamp`, `svix-signature` headers); open during initial setup if `RESEND_WEBHOOK_SECRET` is not set.

**Handled event types:** `email.bounced`, `email.complained` (all others are silently acked)

**Request body** — Resend webhook event JSON.

**Response**

```json
{ "ok": true }
```

On bounce or complaint: marks `email_outbox` row as `bounced`, upserts into `email_suppression`, writes audit row.

---

## 2. User (dashboard token) endpoints

The `{token}` path segment is `users.dashboard_token` — treat it as a credential. All these endpoints resolve the user from the token; return 404 if not found or deleted.

---

### `GET /api/me/{token}`

Full dashboard data for the authenticated user.

**Auth:** dashboard token in URL  
**Rate limit:** 600 req/hr per IP  
**CSRF:** none (GET is idempotent)

**Response**

```json
{
  "user": {
    "legal_name": "Jane Smith",
    "email": "jane@example.com",
    "yt_channel_id": "UCxxxxxxx",
    "yt_display_name_seen": "JaneS",
    "state": "active",
    "code_state": "active",
    "code_expires_at": "ISO8601",
    "email_prefs": { "monthly_cert": true, "cert_style": "bundled" },
    "show_on_leaderboard": false,
    "badge_token": "...",
    "created_at": "ISO8601",
    "verified_at": "ISO8601"
  },
  "attendance": [ { "stream_id": "...", "earned_cpe": 0.5, "first_msg_at": "ISO8601", "rule_version": 1, "source": "poller", "scheduled_date": "2026-04-22", "yt_video_id": "...", "title": "...", "per_session_cert_exists": false } ],
  "certs": [ { "id": "...", "public_token": "...", "period_yyyymm": "202604", "cpe_total": 5.0, "sessions_count": 10, "state": "generated", "cert_kind": "bundled", "stream_id": null, "generated_at": "ISO8601", "delivered_at": "ISO8601", "first_viewed_at": null } ],
  "appeals": [ { "id": "...", "claimed_date": "2026-04-10", "state": "open", "created_at": "ISO8601", "resolved_at": null } ],
  "total_cpe_earned": 22.0,
  "streaks": { "current": 7, "longest": 21, "last_date": "2026-04-22" },
  "code_window_warnings": [ { "kind": "code", "posted_at": "ISO8601", "window_open_at": "ISO8601", "seen_at": "ISO8601" } ],
  "today": { "stream_id": "...", "yt_video_id": "...", "title": "...", "state": "live", "scheduled_date": "2026-04-24", "actual_start_at": "ISO8601", "actual_end_at": null, "credited": false }
}
```

`code_state` is `none` | `active` | `expired`. `today` is `null` when no stream is live or complete today.

---

### `POST /api/me/{token}/delete`

Soft-delete the account (GDPR Art. 17). Scrubs PII; retains cert rows as evidentiary artefacts under Art. 17(3)(e).

**Auth:** dashboard token in URL  
**CSRF:** `isSameOrigin()` required  
**Rate limit:** 5 req per IP (lifetime; no window)

**Request body**

```json
{ "confirm": "DELETE" }
```

**Response**

```json
{
  "ok": true,
  "deleted_at": "ISO8601",
  "certs_retained": true,
  "note": "..."
}
```

Side effects: rotates `dashboard_token` (invalidates all existing links), queues `account_deleted` email, writes audit row `user_deleted`.

---

### `POST /api/me/{token}/prefs`

Patch `users.email_prefs` JSON and/or `show_on_leaderboard`.

**Auth:** dashboard token in URL  
**CSRF:** `isSameOrigin()` required  
**Rate limit:** none

**Request body** (all fields optional; omit unchanged fields)

```json
{
  "cert_style": "bundled",
  "monthly_cert": true,
  "unsubscribed": ["monthly_digest"],
  "renewal_tracker": { "cert_name": "CISSP", "deadline": "2027-01-01", "cpe_required": 120 },
  "show_on_leaderboard": false
}
```

`cert_style`: `bundled` | `per_session` | `both`  
`unsubscribed` valid values: `monthly_digest` | `cert_nudge` | `renewal_nudge` | `streak_milestone`  
`renewal_tracker`: set to `null` to clear.

**Response**

```json
{ "ok": true, "email_prefs": { ... }, "show_on_leaderboard": false }
```

---

### `POST /api/me/{token}/rotate`

Rotate `dashboard_token` and `badge_token`. New token delivered by email only.

**Auth:** dashboard token in URL  
**CSRF:** `isSameOrigin()` required  
**Rate limit:** 3 req/hr per user

**Request body:** none  
**Response:** `{ "ok": true, "email_sent": true }`

Side effect: writes audit row `dashboard_token_rotated`.

---

### `POST /api/me/{token}/resend-code`

Issue a fresh 6-character verification code (extends expiry 72 h). Refuses if user is already verified.

**Auth:** dashboard token in URL  
**CSRF:** `isSameOrigin()` required  
**Rate limit:** 3 req/hr per user

**Request body:** none  
**Response:** `{ "ok": true, "code_expires_at": "ISO8601" }`

Side effect: writes audit row `verification_code_resent`.

---

### `POST /api/me/{token}/appeal`

File a missed-attendance appeal.

**Auth:** dashboard token in URL  
**CSRF:** `isSameOrigin()` required  
**Rate limit:** 10 requests lifetime per user; max 3 open appeals

**Request body**

```json
{ "claimed_date": "2026-04-10", "evidence_text": "optional, ≤ 500 chars" }
```

**Response:** `{ "ok": true, "id": "<appeal-ulid>" }`

Returns 409 if already credited, if an open appeal already exists for that date, or if `> 3` open appeals exist. Returns 404 if no stream is on record for the claimed date.

---

### `POST /api/me/{token}/cert-feedback`

Submit feedback on a certificate. Deduped per (user, cert); repeat overwrites.

**Auth:** dashboard token in URL  
**CSRF:** `isSameOrigin()` required  
**Rate limit:** 20 req per user

**Request body**

```json
{ "cert_id": "<ULID>", "rating": "ok", "note": "optional, ≤ 500 chars" }
```

`rating`: `ok` | `typo` | `wrong`

**Response:** `{ "ok": true, "rating": "typo", "cert_id": "..." }`

Non-`ok` ratings write audit row `cert_feedback_issue`.

---

### `POST /api/me/{token}/cert-per-session/{stream_id}`

Request a per-session CPE certificate for a single stream the user attended.

**Auth:** dashboard token in URL  
**CSRF:** `isSameOrigin()` required  
**Rate limit:** 20 req/day per user

**Request body:** none

**Response (queued)**

```json
{ "ok": true, "queued": true, "cert_id": "...", "state": "pending", "note": "..." }
```

**Response (already exists)**

```json
{ "ok": true, "queued": false, "existing": true, "cert_id": "...", "state": "generated", "public_token": "..." }
```

Returns 404 if the user did not attend the specified stream. The PDF is generated by the pending-pickup cron (runs every 2 h).

---

### `GET /api/me/{token}/annual-summary`

CPE summary for a calendar year, broken down by month.

**Auth:** dashboard token in URL  
**CSRF:** none (GET)  
**Rate limit:** none

**Query params:** `year` (integer 2020–2100; defaults to current UTC year)

**Response**

```json
{
  "year": 2026,
  "total_cpe": 22.0,
  "sessions_attended": 44,
  "certs_issued": 3,
  "months": [ { "month": 1, "cpe": 3.0, "sessions": 6 }, ... ]
}
```

---

### `GET /api/me/{token}/unsubscribe`

Renders an HTML confirmation page for one-click unsubscribe (RFC 8058).

**Auth:** dashboard token in URL  
**CSRF:** none (by design — required for RFC 8058 compatibility)

**Query param:** `cat` — one of `monthly_digest` | `cert_nudge` | `renewal_nudge` | `streak_milestone`

**Response:** `text/html` confirmation form.

### `POST /api/me/{token}/unsubscribe`

Applies the unsubscribe. No CSRF gate (required for RFC 8058 one-click).

**Query param:** `cat` (same values as GET)  
**Request body:** none (form POST from confirmation page)

**Response:** JSON `{ "ok": true, "unsubscribed": "monthly_digest" }` or HTML success page (when `Accept: text/html`).

---

## 3. Onboarding endpoints

### `POST /api/register`

Create a new account or re-issue a verification code for a pending account.

**Auth:** none  
**Rate limit:** 10 successful Turnstile verifications/hr per IP  
**Kill switch:** `register`

**Request body**

```json
{
  "email": "jane@example.com",
  "legal_name": "Jane Smith",
  "legal_name_attested": true,
  "tos": true,
  "tos_version": "v1",
  "turnstile_token": "..."
}
```

**Response**

```json
{ "ok": true, "email_sent": true, "expires_at": "ISO8601" }
```

Returns 409 `{ "error": "already_registered", "recover_url": "/dashboard.html" }` if an active account exists with that email. Never returns the `dashboard_token` or `verification_code` in the response.

---

### `POST /api/recover`

Send a dashboard recovery link to the address on file.

**Auth:** none  
**Rate limit:** 5 req/hr per IP; 429 returns the same constant 200 to prevent enumeration  
**Kill switch:** `recover`

**Request body**

```json
{ "email": "jane@example.com", "turnstile_token": "..." }
```

**Response** (always the same, regardless of match)

```json
{ "ok": true, "message": "If that email is registered, we've sent a recovery link." }
```

---

### `GET /api/verify/{token}` — see Public endpoints.

---

### `GET /api/preflight/channel`

Pre-flight check: is a YouTube channel ID valid and available?

**Auth:** none  
**Rate limit:** 20 req/hr per IP; 10 probes/day per channel ID  
**Kill switch:** `preflight`

**Query param:** `q` — bare channel ID (`UCxxxxxxx`) or a `youtube.com/channel/<id>` URL. Handle URLs (`/@handle`) are rejected.

**Response**

```json
{ "valid": true, "normalized": "UCxxxxxxx", "available": true }
```

Returns 400 on parse errors with `error` values: `empty` | `not_a_channel_id_or_url` | `not_a_youtube_url` | `handle_not_supported_use_channel_id` | `could_not_extract_channel_id`.

---

## 4. Open Badges v3

### `GET /api/ob/credential/{token}.json`

Export a CPE certificate as a signed Open Badge v3 / W3C Verifiable Credential.

**Auth:** none  
**Rate limit:** 120 req/hr per IP

**Path:** `token` is `certs.public_token` (trailing `.json` is stripped automatically)

**Response** (200 `application/ld+json`)

```json
{
  "@context": ["https://www.w3.org/ns/credentials/v2", "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json"],
  "id": "https://…/api/ob/credential/{token}.json",
  "type": ["VerifiableCredential", "OpenBadgeCredential"],
  "issuer": { "id": "...", "type": ["Profile"], "name": "Simply Cyber", "url": "..." },
  "validFrom": "ISO8601",
  "name": "Simply Cyber CPE Certificate — April 2026",
  "credentialSubject": { "type": ["AchievementSubject"], "achievement": { ... } },
  "proof": {
    "type": "DataIntegrityProof",
    "cryptosuite": "eddsa-rdfc-2022",
    "verificationMethod": "…/api/ob/jwks#ob-signing-key",
    "proofPurpose": "assertionMethod",
    "created": "ISO8601",
    "proofValue": "..."
  }
}
```

Returns 404 for revoked, regenerated, or pending certs. Returns 503 if `OB_SIGNING_KEY` is not configured. Writes audit row `credential_exported`.

---

### `GET /api/ob/jwks`

Ed25519 public key in JWK Set format for verifying Open Badge proofs.

**Auth:** none  
**Cache-Control:** `public, max-age=86400`  
**CORS:** `Access-Control-Allow-Origin: *`

**Response**

```json
{
  "keys": [{
    "kty": "OKP", "crv": "Ed25519", "x": "...",
    "kid": "ob-signing-key", "use": "sig", "alg": "EdDSA"
  }]
}
```

Returns 503 if `OB_SIGNING_KEY` is not configured.

---

## 5. Admin endpoints

All admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>`. They are CSRF-immune (bearer tokens are not auto-sent cross-origin by browsers).

---

### `GET /api/admin/users`

Free-text search over users. Does not return `dashboard_token` or `verification_code`.

**Query params**

| Param | Default | Description |
|-------|---------|-------------|
| `q` | required | 2–200 char search string; matched against email, name, `yt_channel_id`, or ULID |
| `limit` | 20 | 1–100 |

**Response**

```json
{ "ok": true, "query": "jane", "count": 1, "users": [ { "id": "...", "email": "...", "legal_name": "...", "yt_channel_id": "...", "yt_display_name_seen": "...", "state": "active", "created_at": "...", "verified_at": "...", "deleted_at": null, "attendance_count": 22, "cert_count": 3, "open_appeal_count": 0 } ] }
```

Writes audit row `admin_user_search` (query stored as SHA-256 hash, not plaintext).

---

### `GET /api/admin/appeals`

List appeals queue.

**Query params**

| Param | Default | Description |
|-------|---------|-------------|
| `state` | `open` | `open` \| `granted` \| `denied` \| `cancelled` \| `any` |
| `limit` | 50 | 1–200 |

**Response**

```json
{ "ok": true, "count": 2, "appeals": [ { "id": "...", "user_id": "...", "claimed_date": "2026-04-10", "yt_display_name_used": "...", "evidence_text": "...", "state": "open", "resolution_notes": null, "resolved_by": null, "resolved_at": null, "created_at": "...", "email": "...", "legal_name": "...", "yt_channel_id": "...", "yt_video_id": "...", "stream_title": "...", "scheduled_date": "2026-04-10" } ] }
```

---

### `POST /api/admin/appeals/{id}/resolve`

Resolve an appeal as granted, denied, or cancelled.

**Request body**

```json
{
  "decision": "grant",
  "notes": "Chat replay confirmed",
  "resolver": "admin-handle",
  "rule_version": 1
}
```

`rule_version` is required when `decision` is `grant`. `notes` max 2000 chars; `resolver` max 80 chars.

**Response**

```json
{ "ok": true, "appeal_id": "...", "state": "granted", "attendance_inserted": true, "resolved_at": "ISO8601" }
```

Returns 409 if appeal is not in state `open`. On `grant`, inserts an attendance row with `source = 'appeal_granted'` (idempotent — handles concurrent grants). On `deny`, queues `appeal_denied` email to the user.

---

### `POST /api/admin/attendance`

Manually grant attendance credit with `source = 'admin_manual'`.

**Request body**

```json
{
  "user_id": "...",
  "stream_id": "...",
  "reason": "Poller was down",
  "resolver": "admin-handle",
  "rule_version": 1,
  "chat_evidence": {
    "yt_message_id": "...",
    "published_at": "ISO8601",
    "display_message": "the chat text"
  }
}
```

`chat_evidence` is optional. When provided, `published_at` must fall within the live window (`actual_start_at - pre_start_grace_min`). Out-of-window evidence is rejected (409).

**Response**

```json
{ "ok": true, "user_id": "...", "stream_id": "...", "source": "admin_manual", "earned_cpe": 0.5, "chat_evidence_present": false, "created_at": "ISO8601" }
```

Returns 409 if attendance already exists for that (user, stream).

---

### `POST /api/admin/revoke`

Revoke a certificate.

**Request body**

```json
{ "public_token": "...", "reason": "Fraudulent attendance" }
```

`reason` max 500 chars.

**Response**

```json
{ "ok": true, "cert_id": "...", "public_token": "...", "revoked_at": "ISO8601", "revocation_reason": "..." }
```

Idempotent: revoking an already-revoked cert returns `{ "ok": true, "already_revoked": true, ... }`.

---

### `GET /api/admin/user/{id}/certs`

List all certificates for a user by ULID.

**Response**

```json
{ "ok": true, "user_id": "...", "count": 3, "certs": [ { "id": "...", "public_token": "...", "period_yyyymm": "202604", "cert_kind": "bundled", "stream_id": null, "cpe_total": 5.0, "sessions_count": 10, "state": "generated", "revoked_at": null, "revocation_reason": null, "created_at": "...", "supersedes_cert_id": null } ] }
```

---

### `POST /api/admin/cert/{id}/reissue`

Queue a cert regeneration. Creates a new `pending` cert row superseding the original; the pending-pickup cron generates and delivers the new cert.

**Path:** `{id}` is `certs.id` (ULID)

**Request body**

```json
{ "reason": "Name typo in original" }
```

`reason` max 500 chars.

**Response**

```json
{ "ok": true, "reissued": true, "pending_cert_id": "...", "supersedes_cert_id": "..." }
```

Returns `{ "ok": true, "reissued": false, "pending_cert_id": "..." }` if a pending reissue already exists. Returns 409 for revoked or already-superseded certs.

---

### `POST /api/admin/cert/{token}/resend`

Re-queue the cert delivery email with a fresh durable download URL.

**Path:** `{token}` is `certs.public_token`  
**Rate limit:** 5 req per cert

**Request body:** none

**Response**

```json
{ "ok": true, "cert_id": "...", "public_token": "...", "to": "...", "download_url": "...", "queued_at": "ISO8601", "idempotency_key": "..." }
```

Returns 409 for revoked certs, certs without a PDF, or deleted users.

---

### `GET /api/admin/cert-feedback`

List cert feedback (default: non-`ok` ratings only).

**Query params**

| Param | Default | Description |
|-------|---------|-------------|
| `rating` | `typo,wrong` | comma-separated list of `ok` \| `typo` \| `wrong` |
| `limit` | 100 | 1–500 |

**Response**

```json
{ "ok": true, "count": 5, "rows": [ { "id": "...", "rating": "typo", "note": "...", "cert_id": "...", "period_yyyymm": "202604", "cert_kind": "bundled", "cert_state": "generated", "public_token": "...", "user_id": "...", "email": "...", "legal_name": "...", "reissue_pending": false, "created_at": "...", "updated_at": "..." } ] }
```

`reissue_pending` is `true` if a `pending` cert already supersedes this one.

---

### `GET /api/admin/heartbeat-status`

Detailed heartbeat status for all cron sources.

**Response**

```json
{ "ok": true, "now": "ISO8601", "stale_count": 0, "sources": [ { "source": "poller", "last_beat_at": "ISO8601", "last_status": "ok", "detail_json": "...", "stale": false, ... } ] }
```

`ok` is `false` when any source is stale.

---

### `GET /api/admin/ops-stats`

Operational dashboard rollup. Covers last 24 h and all-time counts.

**Response**

```json
{
  "ok": true,
  "now": "ISO8601",
  "users": { "total": 120, "active": 95, "pending": 18, "active_no_channel": 2 },
  "last_24h": { "attendance": 45, "certs_issued": 3 },
  "certs_total": 280,
  "appeals_open": 1,
  "email_outbox": { "queued": 2, "failed": 0, "sent_24h": 12, "oldest_queued_age_seconds": 30, "oldest_failed_age_seconds": null },
  "certs": { "pending": 0, "oldest_pending_age_seconds": null },
  "audit_tip": { "id": "...", "ts": "ISO8601", "prev_hash": "..." },
  "fixture_pollution": { "streams": 0, "attendance": 0, "users": 0 },
  "warnings": [ { "level": "warn", "code": "appeals_open", "detail": "1 open appeal(s)..." } ]
}
```

`warnings` is an array of `{ level, code, detail }` objects. `level` is `warn` or `critical`.

---

### `GET /api/admin/toggles`

List all kill switch states.

**Response**

```json
{ "ok": true, "toggles": [ { "name": "register", "killed": false }, { "name": "recover", "killed": false }, { "name": "preflight", "killed": false } ] }
```

### `POST /api/admin/toggles`

Enable or disable a kill switch.

**Request body**

```json
{ "name": "register", "killed": true }
```

`name` must be one of the known kill switches: `register` | `recover` | `preflight`.

**Response:** `{ "ok": true, "name": "register", "killed": true }`

Writes audit row `kill_switch_toggled`.

---

### `GET /api/admin/audit-chain-verify`

Walk the audit log and verify hash-chain integrity.

**Query params:** `limit` (default 1000, max 50000)

**Response**

```json
{
  "ok": true,
  "rows_checked": 1000,
  "first_break": null,
  "unique_index_on_prev_hash": true,
  "index_warning": null
}
```

`ok` is `false` when any hash mismatch is found or the `UNIQUE INDEX` on `prev_hash` is missing. Returns 500 on failure.

---

### `GET /api/admin/security-events`

Last 24 h of rate-limit trips, CSP violations, and honeypot hits from KV.

**Response**

```json
{
  "total_events_24h": 3,
  "events": {
    "rl_trip:register": { "total_24h": 2, "hourly": [ { "hour": "2026-04-24T10", "count": 2 } ] }
  },
  "kill_switches": { "register": false, "recover": false, "preflight": false },
  "csp_violations_recent": [ { "blocked": "...", "directive": "...", "document": "...", "ts": "ISO8601" } ],
  "honeypot_hits_recent": [],
  "checked_at": "ISO8601"
}
```

---

### `POST /api/admin/canary-beat`

Record a canary heartbeat. Called by the hourly smoke GitHub Action at the end of a successful run.

**Headers:** `X-Canary-Sha: <git-sha>` (optional)

**Response:** `{ "ok": true, "source": "canary", "last_beat_at": "ISO8601" }`

---

### `GET /api/admin/export`

Download a CSV export of users, attendance, or certs.

**Query param:** `type` — `users` | `attendance` | `certs`

**Response:** `text/csv; charset=utf-8` attachment named `sc-cpe-{type}-{date}.csv`

**Columns**

| type | columns |
|------|---------|
| `users` | id, email, legal_name, yt_channel_id, state, show_on_leaderboard, current_streak, longest_streak, last_attendance_date, created_at, verified_at |
| `attendance` | user_id, email, legal_name, stream_id, scheduled_date, yt_video_id, title, earned_cpe, source, first_msg_at, created_at |
| `certs` | cert_id, public_token, user_id, email, legal_name, period, cpe_total, sessions_count, cert_kind, state, generated_at, delivered_at, created_at |

Excludes rows where `users.deleted_at IS NOT NULL`.

---

### `GET /api/admin/analytics/growth`

User registration and activity growth metrics.

**Query params**

| Param | Default | Description |
|-------|---------|-------------|
| `range` | `30d` | `7d` \| `30d` \| `90d` \| `all` |
| `granularity` | auto | `daily` \| `weekly` \| `monthly` |

**Response**

```json
{
  "ok": true,
  "headlines": {
    "total_users": 120,
    "active_users": 95,
    "verified_users": 90,
    "active_attenders_30d": 60,
    "new_registrations": 15
  },
  "series": [ { "period": "2026-04-01", "count": 3 } ]
}
```

---

### `GET /api/admin/analytics/engagement`

Attendance and CPE engagement metrics.

**Query params:** same as `growth`

**Response**

```json
{
  "ok": true,
  "headlines": {
    "avg_attendance_per_stream": 8.5,
    "total_cpe_awarded": 440.0,
    "streams_with_zero_attendance": 1
  },
  "series": [ { "period": "2026-04-01", "count": 12 } ]
}
```

---

### `GET /api/admin/analytics/certs`

Certificate issuance metrics.

**Query params:** `range` (see `growth`)

**Response**

```json
{
  "ok": true,
  "headlines": {
    "issued_this_period": 28,
    "pending_now": 2,
    "avg_delivery_seconds": 4200,
    "view_rate_pct": 72
  },
  "series": [ { "period": "202604", "count": 28 } ]
}
```

---

### `GET /api/admin/analytics/system`

Email delivery and appeals system metrics.

**Query params:** same as `growth`

**Response**

```json
{
  "ok": true,
  "headlines": {
    "email_success_rate_pct": 98,
    "emails_sent": 450,
    "appeals_open": 1,
    "avg_appeal_resolution_seconds": 7200
  },
  "series": [ { "period": "2026-04-01", "sent": 15, "failed": 0 } ]
}
```

### `GET /api/admin/streams`

Recent livestream sessions with attendance counts.

**Auth:** bearer  
**Rate limit:** 60 req/hr per IP

**Query parameters**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `days` | int | `30` | 1–365, clamped |

**Response**

```json
{
  "ok": true,
  "streams": [
    {
      "id": "ULID",
      "yt_video_id": "dQw4w9WgXcQ",
      "title": "Daily Threat Briefing — 2026-04-24",
      "scheduled_date": "2026-04-24",
      "state": "ended",
      "actual_start_at": "2026-04-24T12:00:00Z",
      "actual_end_at": "2026-04-24T13:00:00Z",
      "attendance_count": 42
    }
  ]
}
```

### `POST /api/admin/suspend`

Suspend or unsuspend a user. Suspended users cannot earn attendance or receive certs. Writes an audit trail entry.

**Auth:** bearer  
**Rate limit:** 30 req/hr per IP

**Body**

```json
{
  "user_id": "ULID",
  "suspended": true,
  "reason": "Policy violation"
}
```

**Response**

```json
{ "ok": true, "user_id": "ULID", "suspended_at": "2026-04-24T18:00:00Z" }
```

Set `suspended: false` to unsuspend; response has `"suspended_at": null`.

**Audit:** `user_suspended` / `user_unsuspended`

### `GET /api/admin/email-suppression`

List email addresses blocked from sending (bounced/complained).

**Auth:** bearer  
**Rate limit:** 60 req/hr per IP

**Response**

```json
{
  "ok": true,
  "suppressions": [
    {
      "email_masked": "use***@example.com",
      "reason": "hard_bounce",
      "event_id": "evt_abc123",
      "created_at": "2026-04-24T10:00:00Z"
    }
  ]
}
```

### `DELETE /api/admin/email-suppression`

Remove an address from the suppression list. Requires the full (unmasked) email.

**Auth:** bearer

**Body**

```json
{ "email": "user@example.com" }
```

**Response:** `{ "ok": true }`

**Errors:** `not_found` (404) if the email is not suppressed.

**Audit:** `suppression_removed`

---

## 6. Admin auth

Magic-link email authentication for the admin panel UI. These endpoints are separate from the bearer-token auth used by the API — they issue a session cookie consumed by the admin SPA.

---

### `POST /api/admin/auth/login`

Request a magic-link login email.

**Auth:** none  
**Rate limit:** 5 req/hr per IP; 429 returns the same constant 200 to prevent enumeration

**Request body**

```json
{
  "email": "admin@example.com",
  "turnstile_token": "...",
  "redirect": "/admin.html"
}
```

`redirect` must start with `/` (not `//`); defaults to `/admin.html`.

**Response** (always the same, regardless of match)

```json
{ "ok": true, "message": "If that email is an admin account, we've sent a login link." }
```

The link is valid for 15 minutes and contains a one-time nonce stored in KV.

---

### `GET /api/admin/auth/callback`

Validate the magic-link token and issue a session cookie.

**Auth:** none (token in query string is the auth)

**Query params:** `token` (magic-link JWT), `redirect` (safe path starting with `/`)

**Response:** `302` redirect to `redirect` (or `redirect?error=expired` on failure), plus `Set-Cookie` with a signed session cookie.

Writes audit row `admin_login` with `method: "magic_link"` on success.

---

### `POST /api/admin/auth/logout`

Clear the session cookie.

**Auth:** none

**Request body:** none  
**Response:** `{ "ok": true }` plus `Set-Cookie` that expires the session cookie immediately.

---

## 7. Internal endpoint

### `GET /api/watchdog-state`

Read the alert-dedup state used by the GitHub Actions watchdog.

**Auth:** `X-Watchdog-Secret` header  
**Response:** `{ "alerted": { "poller": "ISO8601", "purge": null } }`

---

### `POST /api/watchdog-state`

Write alert-dedup state for the watchdog.

**Auth:** `X-Watchdog-Secret` header

**Request body**

```json
{ "source": "poller", "alert_start": "ISO8601" }
```

Set `"clear": true` to remove a source from the alerted map (i.e., mark it recovered).

`source` regex: `/^[a-z0-9_:.-]{1,64}$/` — supports `warn:` and `heal:` tracking prefixes.

**Response:** `{ "ok": true, "alerted": { ... } }`
