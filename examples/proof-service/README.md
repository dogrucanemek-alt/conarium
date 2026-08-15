# Conarium proof service

This is the **repo seat** for `/opt/conarium-proof` — the public `/proof`
page that renders a signed receipt as HTML. The live tree on the box is
**not a git checkout**. One copy. If that disk dies, the process dies with
it. This folder exists so the next landing has a place to put the sources
and so the operator can see what the process is without opening the box.

⛔ This README does not contain the service. Claude lands the files from
the box. Do not SSH from here. Do not commit `proof-key.pem`.

## What it is

A small Node HTTP process (`start.mjs` → pm2). It serves the receipt
HTML that `src/receipt-view.ts` already knows how to render. The HTTP
route on the box is `deploy/hetzner-proof-route.mjs` (93 lines there;
not in this tree yet).

It is **not** the MCP gateway and **not** the anchoring service
(`deploy/anchor-service`). Those have their own ports and keys.

## Environment

| Variable | Role |
|---|---|
| `CONARIUM_PROOF_HOST` | Bind address |
| `CONARIUM_PROOF_PORT` | Bind port |
| `CONARIUM_PROOF_SIGNING_KEY` | Path to the Ed25519 key used to sign the proof page. Mode 0600. **Never in git.** |
| `CONARIUM_ROOT` | Path to a Conarium checkout or install, used to resolve receipt HTML |

Live values stay on the box. This file does not invent defaults.

## How the page is rendered

`load-receipt-view.js` on the box already refuses to keep a second HTML
renderer: it loads the function from `CONARIUM_ROOT`. That is the rule
`src/receipt-view.ts` states — a second copy will drift.

Two other files on the box **do** keep copies:

- `dist/governance.js`
- `dist/audit-hash.js`

They are snapshots of this package's `src/governance.ts` and
`src/audit-hash.ts`. A release that changes masking or the audit hasher
will not reach `/proof` until someone recopies those files. That is the
same class of drift `load-receipt-view.js` was written to avoid.

## Can those copies become a package import?

**Possible, not free.** `@conarium-ai/core` already ships `dist/` in the
npm tarball, so a deep import (`@conarium-ai/core/dist/governance.js`)
would compile today. The package `main` is the MCP stdio entry, not a
library API — there is no documented subpath export for Governance or
`computeEntryHash`. Pinning a deep `dist/` path will break the first
time the tarball layout changes.

Safer, and consistent with `load-receipt-view.js`: resolve
`governance.js` / `audit-hash.js` from `CONARIUM_ROOT` (the same install
the gateway runs). Then `/proof` and the gateway cannot disagree.
Adding a real `exports` map on the package is a later, documented
change — not this folder's job.

## pm2

On the box the process is started from `start.mjs` (the file carries a
guard comment). After the sources land here, the same shape is:

```bash
# CONARIUM_PROOF_* and CONARIUM_ROOT must already be in the environment.
# The signing key path points at a 0600 file that is not in this repo.
pm2 start start.mjs --name conarium-proof
pm2 save
```

`pm2 status` saying `online` is not proof it is listening. Probe the
bound host:port.

## What must never enter git

| Pattern | Why |
|---|---|
| `proof-key.pem` / `*.pem` | Signing material. `.gitignore` already has `*.pem`. |
| `*.bak-*` / `dist/*.bak-*` | Hand backups on the box (`proof.js.bak-0210`, `.bak-20260814`). |

If you are about to `git add examples/proof-service`, look at `git status`
for a `.pem` or a `.bak-*` first.
