# OpenSSF Best Practices — draft answers

These were the answers prepared before filing. They were filed, and the filed
copy is the one that counts: <https://www.bestpractices.dev/projects/14160>.
Read that page for the current answers and the badge's current level — this
file is kept for provenance, is not updated when an answer changes there, and
says nothing about what the badge shows today.

Project: Conarium (`@conarium-ai/core`)
Homepage: https://conarium.dev
Repo: https://github.com/dogrucanemek-alt/conarium
License: MIT (`LICENSE`)
Description: Governed MCP gateway: policy + PII masking, an Ed25519-signed
receipt per access that a third party verifies offline, and coverage
reconciliation against the database's own query counters.

## Basics

| Question | Answer | Evidence |
|---|---|---|
| Project URL / description | Yes | README, package.json `description` |
| FLOSS license | MIT | `LICENSE` |
| Discussion / issues | GitHub issues | repo |
| Documentation | README, `docs/`, LIMITATIONS.md | — |
| Sites HTTPS | Yes | conarium.dev, npm, GitHub |

## Change control

| Question | Answer | Evidence |
|---|---|---|
| Public version control | Git / GitHub | — |
| Unique version identifiers | npm + git tags `v0.2.x` | package.json, CHANGELOG |
| Can identify who made each change | Git history | — |
| Review before release | CI on every PR/push | `.github/workflows/security.yml` |

## Reporting

| Question | Answer | Evidence |
|---|---|---|
| Vulnerability report process | Email e.dogru@conarium.dev | SECURITY.md |
| Response acknowledgement | Promised in SECURITY.md | no bounty, said so |
| Archive of reports | Not yet a public advisory stream | repo setting listed in scorecard-repo-settings.md |

## Quality

| Question | Answer | Evidence |
|---|---|---|
| Automated test suite | vitest + `test:checks` | `npm test`, `npm run test:checks` |
| CI on every commit | Yes | `security.yml` name: ci |
| New functionality has tests | Required for behaviour changes | CONTRIBUTING not present — practice, not a file |
| Warnings enabled | `tsc --noEmit` | lint script |
| Working build | `npm ci && npm run build` | — |

## Security

| Question | Answer | Evidence |
|---|---|---|
| Crypto uses well-known libraries | Node `crypto` Ed25519, SHA-256 | `src/keys.ts`, `src/receipt.ts` |
| No homemade crypto | Yes | — |
| Secrets not in repo | gitleaks in CI; `files` allowlist | `.gitleaks.toml`, `test/pack_artefakt.mjs` |
| Input validation at the boundary | SQL gate deny-by-default; receipt schema | `src/governance.ts`, `bin/conarium-verify.mjs` |
| Releases signed / provenance | npm provenance workflow prepared | `publish.yml`, `docs/security/NPM-PROVENANCE.md` |

## Analysis

| Question | Answer | Evidence |
|---|---|---|
| Static analysis | CodeQL + Semgrep + gitleaks | `security.yml` |
| Dynamic analysis / fuzz | Jazzer.js four targets | `fuzz/`, `.clusterfuzzlite/` |
| Dependency policy | `npm audit --omit=dev --audit-level=high` in CI; Dependabot for npm and actions | `security.yml`, `.github/dependabot.yml` |

## Known gaps (do not claim)

- No DCO / signed-off-by required.
- No public security advisory history yet.
- Branch protection and secret scanning are repo settings, not commits.
- OSS-Fuzz application is a draft (`docs/security/oss-fuzz-project.yaml.draft`).
- bestpractices.dev badge is not live until this file is submitted.
