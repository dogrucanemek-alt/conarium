# npm provenance

How a bank checks that an `@conarium-ai/core` tarball was built from this
repository, not from a laptop zip.

This is **not** a published release. The workflow
[`.github/workflows/publish.yml`](../../.github/workflows/publish.yml) is
dispatch-only. It does not run on push. The first publish is a human decision.

## What provenance is

When `npm publish --provenance` runs on GitHub Actions with `id-token: write`,
npm stores a signed attestation: package version ↔ git commit ↔ workflow.

## How to verify (after a provenance-backed release exists)

```bash
npm view @conarium-ai/core@<version> --json
```

Look for attestations / provenance on that version. Then:

```bash
npx npm-provenance-check @conarium-ai/core@<version>
```

or, with GitHub CLI, verify the attestation against this repo:

```bash
gh attestation verify --owner dogrucanemek-alt <downloaded.tgz>
```

If a version has **no** attestation, it was not published through this
workflow (or was published before the workflow existed). Treat that as
undeclared origin — not as "verified".

## What this does not prove

- Not a pentest.
- Not that the commit is free of bugs.
- Not that the operator's install matches the tarball (`npm ci` + lockfile
  does that locally).
