# conarium-proof — the service behind `/proof`

This is the source of the service that answers `demo.conarium.dev/proof`, which
`conarium.dev/proof/live` proxies. It ran for weeks in `/opt/conarium-proof` on
the demo box with **no copy anywhere else**: not a git repository, not a
package, not a backup that records what changed. This directory ends that.

Taken from the running host on 2026-08-20, minus `node_modules`, minus the
generated `proof/` output, and minus the signing key.

## What it is, and what it is not

It is not the gateway. `@conarium-ai/core` is not installed here; the only
dependency is `pgsql-ast-parser`. It serves a rendered view of a receipt chain
that something else produced, over `127.0.0.1:8794`, behind Caddy.

```
conarium.dev/proof/live  →  api/proof.js (Vercel)
                         →  demo.conarium.dev/proof (Caddy)
                         →  127.0.0.1:8794  ←  this service
```

The three static proof files a reader verifies from the README are **not**
served from here any more — they are on the CDN as of 0.2.38. This service
renders the live view, which is a different thing and a slower path.

## Where the version number comes from

The JSON reports `engine.version`, and that number is not written here.
`resolveEngineVersion()` in `dist/proof.js` resolves it in order: an explicit
argument, then `CONARIUM_ENGINE_VERSION`, then `CONARIUM_CORE_PACKAGE_JSON`,
then `CONARIUM_ROOT/package.json` — and falls back to `'unknown'` rather than
to a hardcoded number. That design is deliberate and correct.

On the running host the environment is:

```
CONARIUM_ROOT=/opt/conarium-mcp
```

So the number on the page is whatever `/opt/conarium-mcp/package.json` says.
On 2026-08-20, with `0.2.38` published to npm, that file said **0.2.16** and the
public page said 0.2.16 with it. The stale number is not a bug in this service.
It is an accurate report of an engine that was not updated, which is the more
useful failure of the two.

## Environment

| Variable | Value on the host |
|---|---|
| `CONARIUM_PROOF_PORT` | `8794` |
| `CONARIUM_PROOF_HOST` | `127.0.0.1` |
| `CONARIUM_ROOT` | `/opt/conarium-mcp` — decides the reported version |
| `CONARIUM_PROOF_SIGNING_KEY` | path to the private key, **not in this repo** |
| `CONARIUM_PROOF_CHAIN` | `proof/chain.jsonl` |
| `CONARIUM_PROOF_PUBKEY` | `proof/key.pub.pem` |
| `CONARIUM_PROOF_ANCHOR_FILE` | `proof/anchor.json` |

## What is deliberately absent

- **`proof-key.pem`** — the signing key. `.gitignore` refuses `*.pem` and allows
  `*.pub.pem`, so it cannot be added by accident. The public half is here.
- **`proof/`** — generated output: the chain, its anchors, the anchor sidecar.
  The published copies live on the CDN and in the `nexus` repository.
- **`node_modules`** and the `.bak-*` files that had accumulated on the host.

## Restoring or moving it

`start.mjs` needs the environment above and `npm i` for its one dependency.
Nothing in this directory is built from `conarium-public`; `dist/` is a compiled
copy that was placed there by hand, which is the reason this directory needed to
be recorded rather than regenerated.
