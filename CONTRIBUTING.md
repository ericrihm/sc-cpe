# Contributing to SC-CPE

Thanks for your interest in SC-CPE! This project auto-issues cryptographically verifiable CPE certificates for the Simply Cyber community, and contributions are welcome.

## Reporting bugs

Open a [GitHub Issue](https://github.com/ericrihm/sc-cpe/issues) with steps to reproduce, expected behavior, and what actually happened.

## Suggesting features

Open a [GitHub Issue](https://github.com/ericrihm/sc-cpe/issues) with the label `enhancement`. Describe the use case, not just the solution.

## Security vulnerabilities

**Do not open a public issue.** Email [certs@signalplane.co](mailto:certs@signalplane.co) with `[SECURITY]` in the subject line. See [security.txt](https://sc-cpe-web.pages.dev/.well-known/security.txt) for disclosure policy and SLAs.

## Development setup

```bash
git clone https://github.com/ericrihm/sc-cpe.git
cd sc-cpe
bash scripts/test.sh
```

Requires **Node 20+**. The test suite runs pure-logic unit tests via `node --test`.

## Code style

- No comments unless the *why* is non-obvious. The code should speak for itself.
- No new utility files. Shared helpers go in `pages/functions/_lib.js`.
- Edit existing files rather than adding new ones. The repo is intentionally small.
- Input validation at boundaries only. Trust internal calls.

## Testing

All new pure-logic code needs a `node --test` file wired into `scripts/test.sh`. If your change touches the canonical audit-chain format, `scripts/test_chain_parity.mjs` must still pass.

## Pull request process

1. Branch from `main`: `git checkout -b kind/topic`
2. Make your changes and ensure `bash scripts/test.sh` passes
3. Commit with conventional format: `kind(scope): message`
4. Push and open a PR: `git push -u origin kind/topic && gh pr create --fill`
5. PRs require passing CI (`Node test suite` + `Secret scan (gitleaks)`)
6. All PRs are squash-merged

## Code of conduct

Be kind. Be constructive. We're all here to learn and build something useful for the cybersecurity community.
