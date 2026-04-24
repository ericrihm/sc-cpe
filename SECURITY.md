# Security Policy

## Reporting a vulnerability

Email **[certs@signalplane.co](mailto:certs@signalplane.co?subject=%5BSECURITY%5D%20SC-CPE%20disclosure)** with `[SECURITY]` in the subject line.

Include:
- Description of the vulnerability
- Reproduction steps
- Impact assessment
- Suggested fix (if you have one)

## Response SLA

| Stage | Timeline |
|-------|----------|
| Acknowledgement | 3 business days |
| Triage + assessment | 7 business days |
| Fix or mitigation (P0/P1) | 30 days |

## Scope

**In scope:** authentication/authorization bypasses, certificate forgery, audit
log tampering, cross-user data leakage, XSS/injection, CSRF, rate limit bypass,
information disclosure.

**Out of scope:** DoS without amplification, clickjacking on non-sensitive pages,
best-practice header nits without exploit path, theoretical timing attacks on
high-entropy tokens, social engineering, physical access attacks.

## Rules

- Test against production: `sc-cpe-web.pages.dev`
- Create your own test account
- Do NOT exfiltrate other users' PII or destroy data
- Do NOT spam registration/verification endpoints
- Coordinated disclosure — don't publish before the fix ships

## Recognition

We don't run a paid bug bounty. Valid findings earn credit below and on the
[Hall of Fame](https://sc-cpe-web.pages.dev/security.html#hall-of-fame) page.
Tell us how you'd like to be credited.

## Hall of Fame

<!-- Add entries as: | Date | Researcher | Finding | Severity | -->
| Date | Researcher | Finding | Severity |
|------|-----------|---------|----------|
| | *Be the first* | | |

## Additional resources

- [security.txt](https://sc-cpe-web.pages.dev/.well-known/security.txt)
- [Source code](https://github.com/ericrihm/sc-cpe)
- [Architecture](docs/DESIGN.md)
