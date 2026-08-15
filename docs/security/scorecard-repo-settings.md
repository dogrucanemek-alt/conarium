# Scorecard checks that need a repo setting

These cannot be flipped from a commit. They are listed so a person with
admin on `dogrucanemek-alt/conarium` can do them once.

- Branch protection on `main`: no force-push, no deletion, required status
  checks (`Build, lint & test` at minimum), dismiss stale reviews.
- Default Actions permissions: read for `GITHUB_TOKEN`; no write-all.
- Secret scanning and push protection on.
- Private vulnerability reporting on (Security → Advisories).
- Two-factor required for anyone with write.

The Scorecard workflow publishes to the Security tab. The first run after
this file lands is the score we will quote; do not invent a number before
that run exists.
