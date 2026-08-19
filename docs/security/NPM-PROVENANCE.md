# npm provenance

How a bank checks that an `@conarium-ai/core` tarball was built from this
repository, not from a laptop zip.

Releases are published from
[`.github/workflows/publish.yml`](../../.github/workflows/publish.yml), which is
dispatch-only — it does not run on push, and each release is a human decision.
Published versions carry a provenance attestation; the commands below are how
you check that for yourself rather than taking this page's word for it.

## What provenance is

When `npm publish --provenance` runs on GitHub Actions with `id-token: write`,
npm stores a signed attestation binding package version ↔ git commit ↔ workflow.
The attestation lives in the npm registry and in the public transparency log,
which is what makes it checkable without us.

## How to verify

Ask the registry what it holds for a version:

```bash
npm view @conarium-ai/core@<version> dist --json
```

A provenance-backed version answers with an `attestations` block naming
`https://slsa.dev/provenance/v1`, plus a registry `signatures` entry. Measured
against 0.2.32:

```json
"attestations": {
  "url": "https://registry.npmjs.org/-/npm/v1/attestations/@conarium-ai%2fcore@0.2.32",
  "provenance": { "predicateType": "https://slsa.dev/provenance/v1" }
}
```

To have npm check the signatures and attestations of everything you installed,
including this package:

```bash
npm i @conarium-ai/core
npm audit signatures
```

That prints how many packages have verified registry signatures and how many
have verified attestations, and exits non-zero if a signature fails.

⛔ **`gh attestation verify` does not work here, and the reason is worth
knowing.** That command reads GitHub's own attestation store, which is populated
by `actions/attest-build-provenance`. `npm publish --provenance` writes to the
npm registry and the transparency log instead, so GitHub answers `404` for a
tarball published this way — for both `--owner` and `--repo`. A 404 there is not
evidence of a missing attestation; it means you asked the wrong service. Use the
two commands above.

If a version has **no** attestation, it was not published through this workflow
(or predates it). Treat that as undeclared origin — not as "verified".

## Publisher configuration

Auth is **npm Trusted Publishing (OIDC)**, not a stored token. npm hands the
workflow a short-lived credential in exchange for its GitHub identity, so there
is no long-lived publish secret in this repository to leak.

The trusted publisher is configured on npmjs.com against
`dogrucanemek-alt/conarium` and `publish.yml`. To reproduce it on a fork:

1. `@conarium-ai/core` → **Settings** → **Trusted Publisher**
2. Publisher: **GitHub Actions**
3. Repository: `<owner>/<repo>`
4. Workflow file: `publish.yml`

Releasing: GitHub → **Actions** → **publish** → *Run workflow* → type `publish`
in the confirm box. The workflow runs lint, tests and the adversarial checks
before it publishes, and a claims review record must exist for the version being
shipped; a red gate stops the release.

If npm rejects the OIDC exchange, do **not** fall back to adding an `NPM_TOKEN`
secret. Publish by hand from a workstation for that release and fix the trusted
publisher configuration afterwards — provenance is worth less than a leaked
publish credential costs.

## What this does not prove

- Not a pentest.
- Not that the commit is free of bugs.
- Not that the operator's install matches the tarball (`npm ci` + lockfile
  does that locally).
- Not that the code does what its documentation says. Provenance binds an
  artefact to a build, and stops there.
