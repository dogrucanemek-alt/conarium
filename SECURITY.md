# Security

Conarium sits between an AI assistant and a database. Its whole claim is that it
says what it does and does what it says. A governance layer that quietly fails is
worse than no governance layer, because it converts an unknown risk into a false
assurance. This document is written on that basis: it lists what we protect, what
we do **not** protect, what we found when we attacked our own code, and what we
decided to leave open and why.

## Reporting a vulnerability

Email **e.dogru@conarium.dev**. Please include a reproduction if you have one.
We will confirm receipt, and we will tell you what we did about it — including
"nothing, here is why". There is no bounty programme; this is a small project and
we would rather say so than imply one exists.

## Threat model

**Conarium protects against**

- An AI assistant reading tables, columns or rows that policy does not allow.
- Personal data reaching the model unmasked when policy says it should be masked.
- Write operations reaching the database through the assistant. All connectors are
  read-only; SQL is parsed and guarded, not pattern-matched.
- An access happening without a record. Every tool call — allowed or denied —
  writes a signed, hash-chained, append-only audit entry.
- The audit log being edited after the fact. Entries are Ed25519-signed and chained;
  `conarium-verify` detects tampering, reordering, gaps and truncation, and it runs
  with zero imports from `src/`, so it does not trust the code that wrote the log.

**Conarium does NOT protect against**

- A compromised operator. Whoever controls the config controls the policy.
- A database credential that is already leaked. Conarium is a gateway, not a firewall;
  it governs the path through it, not every path to your database.
- The model itself leaking what it legitimately received. If policy permits a row,
  the assistant sees that row.
- Knowing *which model* is on the other end. MCP does not carry model identity, so
  the receipt records `not declared` rather than guessing. We do not sign what we
  did not measure.
- Anything at the operating-system level: file permissions, process isolation,
  the security of the host running Conarium.

**We do not have** SOC 2, an external penetration test, or a formal security
certification. We are one person. That is not a footnote we would rather you missed;
it is the reason the code is MIT-licensed and runs entirely inside your own
infrastructure. No data reaches us, so there is no vendor to certify.

## Audit of 2026-08-12 — what we found and fixed

An independent static analysis was run against this repository. Four findings were
reported; we verified each against the code rather than accepting the report.

### Fixed

**1. A session was not bound to the identity that opened it.** (`src/http.ts`)

An MCP session is opened by an `initialize` POST, which builds a `Server` carrying
that caller's identity. Subsequent requests were routed by the `Mcp-Session-Id`
header alone, after checking only that the caller held *some* valid token. So a
holder of the shared token, presenting a session id opened with a per-user
credential, would operate with that person's masking profile — and every receipt
from that point on would name the wrong person.

The session id travels in a plain header and lands in proxy logs. It is routing
information, not a secret, and must never be the only thing standing between two
identities. Sessions are now bound to a SHA-256 of the opening credential and
compared in constant time; a mismatch is rejected with 403 before the transport is
touched. Regression test: `test/session_owner.test.mjs`.

**2. `allowTools` / `denyTools` were never enforced.** (`src/governance.ts`, `src/server.ts`)

The fields were documented in `types.ts`, editable in the console, and covered by a
test — but the only implementation lived in `ApiGovernance`, a class nothing in
`src/` imported. An operator could close a tool and nothing would close.

This was **not** an exploitable hole: write operations are refused by the connectors
themselves, and reads pass through `allowsTable`, which is fail-closed. The operator
was protected — but by a rule they did not write and did not know about. The defect
was a false statement, not an open door, and for this product that is the more
serious of the two. `Governance.allowsTool()` is now checked as the first step of
tool dispatch, denied tools are removed from the advertised tool list, and denied
attempts are still written to the audit log. Regression test:
`src/server.tool_policy.test.ts`.

Note: `allowTools` is deliberately fail-**open** when unset, unlike `allowsTable` and
`allowsConnector`. The primary gate is table policy and it is fail-closed; making
this one fail-closed as well would have silently broken every existing deployment
that never set it — the same class of mistake we were fixing.

**3. The chat proxy was open when unconfigured.** (`api/chat.js`)

With no `CONARIUM_CHAT_AUTH_TOKEN` set, the endpoint accepted anonymous calls and
this was documented as "public mode". But a missing configuration is not a decision
to be public. An endpoint left open by accident burns the upstream model key on
strangers' traffic. Anonymous access now requires an explicit
`CONARIUM_CHAT_PUBLIC=1`; otherwise the endpoint returns 503 and says what to set.
Token comparison is also constant-time now.

**4. Dependency tree carried six critical advisories.** (`package.json`)

No test caught this, because tests measure code and not the dependency graph.
`javascript-opentimestamps` pulled in `request` (SSRF; the package was abandoned in
2020 and will not be fixed), `web3` (insecure credential storage) and `crypto-js`
(weak PBKDF2).

Timestamp anchoring is an optional feature and the code already loaded the module
lazily — only `package.json` made it mandatory, so everyone installing the core
was also installing those advisories. It is now an optional peer dependency with a
clear error when anchoring is requested without it. **A production install now
reports zero vulnerabilities.** CI gates on `npm audit --omit=dev --audit-level=high`
so this cannot come back quietly.

### Accepted, not fixed

**DNS rebinding / TOCTOU in the OpenAPI connector.** (`src/connectors/openapi.ts`)

`enforceSafeRemoteUrl` resolves the hostname and rejects private or reserved
addresses, then `fetch` resolves again when it connects. The two resolutions are not
guaranteed to return the same address, so this is a genuine time-of-check /
time-of-use gap.

We have left it open, for three reasons stated plainly so you can disagree:

1. The URL must already be inside `config.allowedBaseUrls`, an operator-authored
   allowlist. Exploiting this requires the operator to have allowlisted a hostname
   under an attacker's control.
2. HTTPS is mandatory. A rebound internal address must still present a valid
   certificate for the allowlisted hostname; an internal service will not have one.
3. Closing it properly means pinning the resolved address at connect time, which
   means adding an HTTP dispatcher dependency — enlarging the dependency surface
   immediately after we spent this audit shrinking it.

If your deployment allowlists hosts you do not fully control, this trade-off is
wrong for you, and we would like to hear about it.

**Known-weak advisories in dev dependencies.** The `vitest` / `vite` chain carries
advisories with no non-breaking fix. They are build-time only and never installed by
`npm install --omit=dev`. The CI audit gate is scoped to the production tree for
this reason — the scope was narrowed to be correct, not to make the number smaller.

## CodeQL findings, triaged

CodeQL ran for the first time on 2026-08-12 and raised twelve alerts. Each was
checked against the code rather than accepted or dismissed on sight. One was real
and is fixed; the rest are false positives and are dismissed in the Security tab
with the reasoning recorded there, not silently closed.

**Fixed — `js/missing-rate-limiting` in `src/console.ts` (4 alerts).** The console
had no rate limit. It binds to `127.0.0.1` and requires a token plus a CSRF header,
so the exposure was narrow — but `CONARIUM_CONSOLE_HOST` can publish it, and in that
configuration nothing slowed a token brute force. A limiter now runs **before**
authentication, deliberately: in `src/http.ts` the limit runs *after* auth so an
unauthorized flood cannot burn a real client's budget, whereas here the thing being
protected is the token itself, and a limit placed after auth would never count the
failed attempts. Same library, opposite order, different reason. Test: case `4b` in
`test/security_hardening_14.mjs`, which sends deliberately wrong tokens.

**False positive — `js/xss-through-dom` in `index.html` (2 alerts).** User input from
the demo's SQL box does reach `innerHTML`, but through `hlsql()`, which passes it
through `esc()` first (`&`, `<`, `>` are encoded). The interpolated `table` value
comes from `/from\s+([a-z_][\w.]*)/`; that character class cannot carry an HTML
metacharacter. CodeQL sees the path and not the two filters on it.

**False positive — `js/missing-rate-limiting` in `src/anchor-service.ts` (2 alerts).**
The service does rate limit, per owner, returning 429 (`src/anchor-service.ts:135-188`).
The limiter is hand-written rather than a recognised middleware, so the query does
not match it.

**False positive — `js/http-to-file-access` in `src/anchor-service.ts` (1 alert).**
The write target is the fixed configured `storePath`; the record id is server-generated
(`randomBytes(9)`), and `req.params.id` is only ever used to *search* stored records,
never to build a path. There is no traversal.

**False positive — `js/file-system-race` in `scripts/` and `bin/` (3 alerts).** These
are developer and CLI tools. Exploiting the check-then-use window requires local write
access to the same filesystem, at which point the tool is not the weakest link.

## Secrets in git history

The full history was scanned for the first time on 2026-08-12 (`gitleaks git .`,
65 commits). Seven findings, all in the initial public release commit `e84f8ba`:

- `demo.ts` contained `sk_live_123456789`, the fake input to the masking demo. It
  had already been replaced with `sk_live_example_not_a_real_key`.
- `site/.next/**` contained Next.js preview and server-action keys. Build output had
  been committed by mistake; the directory was later removed from tracking. Next.js
  regenerates these keys on every build and the site has been redeployed many times
  since, so the values are dead.

**No private key has ever been committed.** The only `.pem` files in history are
public keys (`test-vectors/keys/vector-key.pub.pem`, `test/fixtures/ots/pubkey.pem`).
This was verified, not assumed.

We did **not** rewrite history. Rewriting a public repository's history breaks every
clone and fork, and would have bought the removal of a handful of dead values. Both
findings are allowlisted narrowly — pinned to that commit and to those paths — so a
new secret in the same files would still be caught.

## Automated gates

Every push and pull request runs:

| Gate | What it catches |
|---|---|
| `tsc --noEmit`, `vitest`, `test:checks` | behaviour, including adversarial and conformance suites |
| `npm audit --omit=dev --audit-level=high` | vulnerable production dependencies |
| Gitleaks (working tree **and** full history) | committed secrets, past or present |
| Semgrep (`security-audit`, `secrets`, `javascript`, `typescript`) | injection, crypto misuse, auth mistakes |
| CodeQL (`security-extended`) | dataflow — whether untrusted input actually reaches a sink |

Semgrep matches patterns; CodeQL follows data. They find different things, which is
why both run. CodeQL results are published to the repository's Security tab, so you
can read them without taking our word for it.

Conformance vectors in `test-vectors/` let you verify our receipts with your own
implementation: nine frozen cases with expected exit codes, plus the public key and
canonical hashes. If your verifier disagrees with ours, one of us has a bug, and the
vectors are how we find out which.
