# The `/proof` service, as a consumer of this package

`demo.conarium.dev/proof` renders a signed receipt as HTML. That service is
**not in this repository and does not belong here** — its sources live in the
private site repo (`nexus`: `src/proof.ts`, `src/load-receipt-view.ts`,
`deploy/hetzner-proof-route.mjs`, `start.mjs`). The box directory
`/opt/conarium-proof` is a deploy artifact of that repo, not a separate
codebase.

This note exists for the other direction: the service is a **consumer of this
package**, and two of the ways it consumes are things a release here can break.

⛔ Do not copy the service's files into this tree. A second copy is the drift
this page is warning about.

## What it takes from this package

| It needs | How it gets it |
|---|---|
| Receipt HTML (`src/receipt-view.ts`) | Resolved at runtime from `CONARIUM_ROOT`, never copied |
| `governance.js`, `audit-hash.js` | **Copied** into its own `dist/` on the box |

`load-receipt-view.js` refuses to keep a second HTML renderer and loads the
function from the install `CONARIUM_ROOT` points at. That is the pattern to
follow.

The other two are snapshots. A release here that changes masking or the audit
hasher does **not** reach `/proof` until someone recopies them, so the page can
describe behaviour the engine no longer has. Fixing that belongs in the site
repo, not this one.

## What that means when releasing this package

`CONARIUM_ROOT` on the box points at the gateway install. After an upgrade the
proof process keeps the previously imported module in memory, so it renders the
old HTML until it is restarted. A release is not visible on `/proof` until the
process restarts — `pm2 status` saying `online` does not mean it re-read
anything. Probe the page.

## Could the copies become an import?

**Possible, not free.** `@conarium-ai/core` ships `dist/` in the tarball, so a
deep import (`@conarium-ai/core/dist/governance.js`) compiles today. But the
package `main` is the MCP stdio entry, not a library API, and there is no
documented subpath export for `Governance` or `computeEntryHash`. Pinning a
deep `dist/` path breaks the first time the tarball layout changes.

Resolving both from `CONARIUM_ROOT`, the way the receipt view already is, keeps
`/proof` and the gateway on one copy without inventing an API surface. Adding a
real `exports` map here is a separate, documented change.
