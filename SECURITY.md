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

## Outbound connections

The gateway opens one connection you did not configure: at startup it asks
`https://registry.npmjs.org/@conarium-ai/core/latest` whether a newer version
exists, and writes a single stderr line if so. The request carries no identifier,
no configuration, no usage counts — nothing but the version lookup itself. It has
a 2-second timeout, never blocks startup, and never throws.

- `CONARIUM_NO_UPDATE_CHECK=1` disables it.
- `CONARIUM_NPM_REGISTRY=<url>` points it at an internal mirror.

`conarium-doctor --no-net` makes the same guarantee for the doctor: with that flag
it issues no network request at all. Everything else — connectors, receipts, audit
log, verification — is local to your infrastructure by construction.

## OpenTimestamps client

Anchoring is implemented in-tree (`src/ots/`). It talks to the public
OpenTimestamps calendars over HTTPS and hashes with Node `crypto`.
`javascript-opentimestamps` is not a dependency. Enabling
`CONARIUM_ANCHOR_SINK=opentimestamps` does not install `web3`, `elliptic`,
`crypto-js`, `request`, or `lodash`.
Bitcoin-block checks use `blockstream.info`. Unreachable explorer → exit 15
("could not check"), never a silent pass.

## Countersigning key

The countersigning endpoint (`conarium-anchor-service`) signs with an Ed25519
key read from `CONARIUM_ANCHOR_SIGNING_KEY`. It refuses to start without one,
and refuses a key file other users can read — an unsigned countersigning
service is not one, and a readable key is not a key. The published
`GET /anchor/key.pem` serves the public half only and inspects the file
contents before answering, so a private PEM placed at that path is refused
rather than served.

What the key protects is the whole product: a leaked signing key makes every
countersignature it ever produced worthless, including past ones. Custody,
rotation, and what a compromise costs are in
[`docs/COUNTERSIGN.md`](docs/COUNTERSIGN.md). Since 2026-08-15 a
Conarium-operated endpoint does exist (`demo.conarium.dev/anchor`, keyId
`verax-cs-20260815`), on one server with the key on disk and no HSM; it is not
open to customers. The limits are in [`LIMITATIONS.md`](LIMITATIONS.md).

The tester pack is [`docs/security/THREAT-MODEL.md`](docs/security/THREAT-MODEL.md)
and [`docs/security/PENTEST-SCOPE.md`](docs/security/PENTEST-SCOPE.md).
npm provenance (after a dispatch publish): [`docs/security/NPM-PROVENANCE.md`](docs/security/NPM-PROVENANCE.md).
Those documents are not an audit.

## Threat model

**Conarium protects against**

- An AI assistant reading tables, columns or rows that policy does not allow.
- Personal data reaching the model unmasked when policy says it should be masked.
- Write operations reaching the database through the assistant. All connectors are
  read-only; SQL is parsed and guarded, not pattern-matched.
- An access happening without a record. Every tool call — allowed or denied —
  writes a signed, hash-chained, append-only audit entry.
- The audit log being edited after the fact. Entries are Ed25519-signed and chained;
  `conarium-verify` detects tampering, reordering, and **gaps in the middle** of
  the chain. It does **not** detect records dropped from the **end** of the file
  unless you pass `--expect-count` or `--expect-last-hash` (or check an external
  anchor / reconcile). A leftover prefix of a valid chain still verifies — a hash
  chain is structurally blind to a shorter tail. It runs with zero imports from
  `src/`, so it does not trust the code that wrote the log.

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

**Content scanners — what we do not guess.** Street addresses and bare names
have no deterministic shape. We do not ship a gazetteer or a name list; a
half-working detector would turn the documented gap into a lie. Close those
fields with `maskColumns` / `conarium-suggest-policy`. IP addresses are an
opt-in detector (`policy.detectors.ip`) because a server IP is not always
personal data. Passport MRZ is checksummed (TD3); a free-text "letter plus
eight digits" pattern is not shipped.

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

Measured **2026-08-14** against `main` (`4be8e82`, after the 0.2.7 fixes and a
fresh CodeQL run): **0 open**, **17 dismissed**, every dismissal carrying its
reasoning in the Security tab. The numbers are that query, not a remembered
total. A stale count is the same class of lie this product exists to refuse.

⚠️ **Alert numbers are not stable.** A fix moves a line, CodeQL closes the old
alert and opens a new one at the new position — during 0.2.7 the `mint-token`
finding closed as `#16` and reopened as `#18`, and the new regression test
raised `#19` of its own. Read the classes below, not the numbers.

### What was actually found

**`js/file-system-race` in `examples/per-user-identity/mint-token.mjs` — real, fixed in 0.2.7.**
The file was created at the process umask (usually 0644) and only then
`chmod 0600`. Between those two calls, per-user identity tokens were readable
by another local account. That file is the store behind "a shared credential
does not name a person". It now births with `writeFileSync(..., { mode: 0o600 })`;
`chmod` is a backstop, not the only defence. The same birth permission is on
`src/keys.ts` (`writeKeyPairFiles` private PEM) and `bin/conarium-init.mjs`
(signing key). Measured on ext4 with `umask 0022`: with `mode` present the file
is born `600` even when `chmod` is disabled; with `mode` removed it is born
`644`. Do not read "everything dismissed" as "nothing was real".

**`js/missing-rate-limiting` in `src/console.ts`.**
False positive. A limiter runs **before** authentication, deliberately: in
`src/http.ts` the limit runs *after* auth so an unauthorized flood cannot burn
a real client's budget; here the thing being protected is the token itself
(`test/security_hardening_14.mjs` case `4b`). The query looks for a recognised
middleware; ours is hand-written. Dismiss is a GitHub Security-tab action, not
a code change.

**`js/file-system-race` in `src/console.ts` (config save).** Weak, local tool —
but 0.2.7 closed the practical hole anyway: the save is now temp-file + `rename`
in the same directory, so a crash cannot leave a half-written policy. This alert
**closed on its own** after the fix; it is the one finding here that CodeQL
agreed was resolved rather than dismissed.

**`js/file-system-race` in `bin/conarium-suggest-policy.mjs`.** New file, new
alert — that is normal. The tool is read-only (`--sql`), wrapped in try/catch,
and refuses to write config. There is no privileged sink after the check, so the
window has no consequence. Noise.

**`js/file-system-race` in `test/mint_token_mode.mjs`.** The regression test for
the finding above: it creates a file in a temp directory and stats it to assert
the `0600` birth permission. Dismissed as *used in tests*.

### Earlier rounds

First CodeQL run was 2026-08-12 (twelve alerts). One of those (`js/missing-rate-limiting`
on the console with **no** limiter) was real and was fixed in `270ac54`. The
others were false positives and are dismissed in the Security tab with the
reasoning recorded there:

**`js/missing-rate-limiting` in `src/console.ts` (the original four, plus
follow-ups).** Limiter exists; query does not see a hand-written one.

**`js/xss-through-dom` (2, dismissed 2026-08-12).** Marketing `index.html` that
no longer lives in this repository. The site is `conarium.dev` (private `nexus`
repo). The demo SQL box there still goes through `hlsql()` → `esc()` before
`innerHTML`.

**`js/missing-rate-limiting` in `src/anchor-service.ts` (2).** The service does
rate limit, per owner, returning 429. Hand-written limiter.

**`js/http-to-file-access` in `src/anchor-service.ts` (1).** The write target is
the fixed configured `storePath`; the record id is server-generated
(`randomBytes(9)`), and `req.params.id` is only ever used to *search* stored
records, never to build a path.

**`js/file-system-race` in `scripts/` and `bin/` (3).** Developer and CLI tools.
Exploiting the check-then-use window requires local write access to the same
filesystem, at which point the tool is not the weakest link.

If you are auditing this, do not read "17 dismissed" as "17 non-issues". Two of
them were real and were fixed, not argued away: the console with no rate limiter
(`270ac54`), and the token file that was born world-readable and narrowed
afterwards (0.2.7). Everything else is dismissed with its reasoning attached,
and a dismissal in this repository means *"we looked and wrote down why"*, not
*"we closed it"*.

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
implementation: twelve frozen cases with expected exit codes, plus the public key and
canonical hashes. If your verifier disagrees with ours, one of us has a bug, and the
vectors are how we find out which.
