# Threat model

What an attacker can try. Not a sales page. Not an audit.
There is **no independent penetration test**. This document does not change that.

Measured against this repository (Conarium 0.2.x). Dates are when a fact was
recorded, not promises.

## Assets

| Asset | Why it matters | Where it lives |
|---|---|---|
| Customer PII / secrets in the database | The product exists to keep these off the model | Operator's Postgres (and other connectors) |
| Policy (allow/deny/mask/row-cap) | Whoever writes this decides what the model sees | `conarium.config.json`, console save path |
| Ed25519 signing key | Forges receipts if stolen | `audit-ed25519.pem` (mode 0600 where the OS allows) |
| Receipt / audit chain | Evidence of what was allowed, denied, masked | `audit.sink`, `audit.receiptSink` |
| Per-user tokens | Bind a person to a masking profile | `CONARIUM_TOKENS_FILE` / `conarium.tokens.json` |
| Console token | Opens the policy editor | `CONARIUM_CONSOLE_TOKEN`, `~/.conarium/console.token` |
| MCP token | Opens the HTTP gateway | `CONARIUM_MCP_TOKEN` |

## Actors

| Actor | Intent |
|---|---|
| Honest developer | Uses Cursor/Copilot through the gateway as designed |
| Manipulated AI agent | Follows a prompt that tries to read denied tables, dump rows, or smuggle PII in free text |
| Malicious insider | Holds a valid token or the config; wants to widen policy or rewrite history |
| Process that bypasses the gateway | Connects to the database with the same or another credential, never through Conarium |
| Attacker on the console / HTTP port | Reaches loopback or a mis-bound interface; tries auth, CSRF, session swap |

A compromised operator is in scope as an actor and **out of scope as a defence**.
Whoever controls the config controls the policy. The code cannot save you from yourself.

## Trust boundaries

### 1. AI assistant ↔ gateway

**Today:** MCP stdio or Streamable HTTP. SQL is parsed (`pgsql-ast-parser`), not grepped.
Writes are refused by the connector. Tables not on `allowTables` are denied.
`maskColumns` plus content scanners run before the model sees a row.
Every tool call — allowed or denied — is supposed to write a signed receipt.

**Bypass surface:**
- A bare name in running prose is not detected. "Ahmet called" goes through.
- Street addresses are not detected.
- Passport numbers in free text (non-MRZ) are not detected.
- `allowTools` is fail-**open** when unset. Table policy is the real gate.
- HTTP sessions were once routable by `Mcp-Session-Id` alone (fixed 2026-08-12:
  bound to a hash of the opening credential). Regression: `test/session_owner.test.mjs`.
- A missing config file does **not** stop the gateway. It starts with zero
  connectors and governs nothing. `conarium-doctor` exists because of this.

### 2. Gateway ↔ database

**Today:** Connectors are read-only. The shipped `query` tool selects the
SQL gate from `policy.dialect` (omitted = postgres / `Governance.guardQuery`).
The dialect is not inferred from the statement. Writes, multi-statement, and
unknown AST are rejected. Row cap is applied in the engine.
Supabase REST and docs connectors have their own read-only paths.

**Bypass surface:**
- The database credential, once leaked, is a path around the gateway.
  Conarium is not a firewall.
- `pg_stat_statements` reconciliation trusts the database's own counters.
  An attacker who can falsify those counters is out of scope.
- OpenAPI connector: DNS rebinding / TOCTOU between `enforceSafeRemoteUrl`
  and `fetch` is **accepted, not fixed** (`SECURITY.md`). Exploit requires an
  operator-authored `allowedBaseUrls` entry under attacker control.
- SQL dialects are Postgres, Microsoft SQL Server, and Oracle. A query
  the parser does not understand is denied. MySQL is not implemented.
  Oracle synonyms are not resolved; `table@dblink` is denied.

### 3. Console ↔ operator

**Today:** Binds `127.0.0.1`. Token required. CSRF token on cookie sessions.
Rate limit runs **before** auth (the token is the thing being protected).
Config save is temp-file + `rename` in the same directory.

**Bypass surface:**
- Loopback is not a security boundary on a shared machine.
- `CONARIUM_CONSOLE_TOKEN` in the environment is as strong as the operator's
  process list and shell history.
- The desktop shortcut stores the token in `~/.conarium/console.token` (0600).
  Another local account that can read that file is the operator.
- Chat proxy (`api/chat.js`): anonymous access requires explicit
  `CONARIUM_CHAT_PUBLIC=1`; missing config is 503, not "public".

### 4. Receipt file ↔ auditor

**Today:** Ed25519 + hash chain. `conarium-verify` imports nothing from `src/`.
Middle-gap deletion fails. Tail truncation does **not** fail unless
`--expect-count` / `--expect-last-hash` or an external anchor / reconcile.
Pending OpenTimestamps is disclosed as `pending`. Bitcoin upgrade is hours later.

**Bypass surface:**
- An operator can write false-but-well-formed receipts *before* anchoring.
  Creation-time truth is not proven.
- `{hash, sig, anchor}` are excluded from the content hash. Ed25519-only
  strip-all can pass a boot check; Ed25519 + HMAC catches it.
- A shorter leftover chain still verifies. That is structural, not a bug.
- Anchor calendars and `blockstream.info` are third parties. Unreachable →
  exit 15 ("could not check"), not exit 0.
- The audit sink lock is taken at construct when `sink` is set. The receipt
  sink was not: receipt-only installs, and two processes with different audit
  sinks sharing one receipt file, could fork `seq` / `prevHash`. `log()` now
  takes every sink path it will write, in lexicographic path order, and
  reloads the receipt tail under that lock (see `src/audit.ts`). In-process
  concurrent `log()` is still synchronous (measured: 50 queries, 0 `prevHash`
  breaks). Cross-process writers of the same file are serialized; a lock wait
  that times out throws and fail-closes. Same-file writers that do not go
  through `Audit.log` (a hand-edited append, a second implementation) are
  still unsupported.

## Out of scope — the operator

Conarium's trust boundary is **assistant ↔ gateway**. The operator is inside it.

Code that imports this library can call `CustomSqlConnector.runGoverned`, or
open the database with the same credential. That is the same authority as
connecting to the database directly. It is not a bypass of a defence that was
meant to stop the operator.

The operator's own code does not appear in the audit log. A bank closes that
with their code review, not with this gateway.

This is the product's scope. It is not a vulnerability.

## Out of scope (stated so nobody bills hours here)

- The database's own authentication, authorization, encryption, backups.
- The operating system, disk encryption, process isolation, file permissions
  beyond what this process sets on keys it writes.
- The network path in front of a reverse proxy (TLS, WAF, VPN).
- Hardware key storage (HSM, TPM, OS keychain). The signing key is a PEM file.
- The model leaking data it was *allowed* to see.
- An attacker who already has the operator's shell.

## What this document is not

It is not a pentest. It is not SOC 2. It is not a claim that the surfaces
above are closed. It is the list we would hand a tester so they spend time
on the weak points instead of rediscovering the product.
