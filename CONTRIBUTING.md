# Contributing

Conarium is a governance tool, so the bar it sets for itself is the one it
claims for other people's data: a change is what its evidence shows, not what
its description says. That makes contributing here slightly unusual, and the
unusual parts are written down rather than left to be discovered in review.

`docs/CONTRIBUTING.md` carries one rule that belongs with the code and travels
in the package: **a setting that reduces protection must be noisy.** This file is
the process around it.

## Reporting a bug

Open an issue: <https://github.com/dogrucanemek-alt/conarium/issues>

Useful reports contain a command and its output. If you can give the receipt
chain, the config (with secrets removed — `conarium-doctor` will tell you if it
still has any), and what you expected instead, that is enough to reproduce.

⛔ **Do not open a public issue for a security vulnerability.** Email
`e.dogru@conarium.dev` instead. The process, and what you can expect back, is in
[`SECURITY.md`](SECURITY.md).

Issues are answered by one maintainer. If a report sits for a week, it was
missed rather than declined — say so on the thread.

## Suggesting a change

Open an issue before a large pull request. Not for permission — to find out
whether the thing you are about to build is already refused somewhere in
[`LIMITATIONS.md`](LIMITATIONS.md), which is a longer file than most projects
have and is the fastest way to learn what this tool deliberately does not do.

## Pull requests

1. Fork, branch, and keep the change to one subject.
2. `npm ci`
3. `npm run test:all` — this runs `lint`, the test suite, and the adversarial
   checks. All three must pass.
4. Open the pull request. CI runs the same commands on Node 20, 22 and 24, plus
   CodeQL, Semgrep, a container smoke test and a fuzzing budget.

### Tests are part of the change, and guards are shown red first

A fix without a test that fails before it is not finished. That is ordinary. The
part that is not ordinary:

> **A new guard must be demonstrated failing on the defect it is written for,
> before it is wired in.**

A check that has only ever been green proves nothing about what it would catch.
Put the demonstration in the pull request body — the broken input, the exit code,
the message. Several guards in `test/` exist because a green check was trusted
and the thing it was supposed to catch shipped anyway.

### Claims are reviewed like code

If your change edits a sentence that a reader could act on — the README, the
docs, the site copy, a tool description — it changes a claim surface. Ask one
question of it:

> Does this sentence say more than the mechanism behind it proves?

`node test/denetci.mjs input <base> HEAD` prints what changed on those surfaces.
Findings do not block a release; unread surfaces do. Version bumps carry a
review record under `docs/claims/reviews/`, and `test/release_record.mjs` refuses
a bump without one.

### Changelog

A version bump needs its `CHANGELOG.md` section, and the publish workflow refuses
a release whose section does not exist. Write what changed and why; entries here
are release notes, not commit summaries.

## What gets a change rejected

- A guard that was never shown failing.
- A claim the code does not support, including one in a comment.
- A setting that reduces protection quietly.
- Turning a red check green by widening its exemption list rather than fixing
  what it caught.

## Honest note on review

This project has one maintainer. Pull requests are merged without a second
approver, which is a real weakness and is recorded as one — see the bus factor
entry in [`LIMITATIONS.md`](LIMITATIONS.md) and the `Code-Review` score on the
project's OpenSSF Scorecard, which is 0 for exactly this reason.

External review has happened and is welcome: findings from the IETF SCITT mailing
list and from independent tools have each produced released fixes, credited in
`CHANGELOG.md`. If you want to review rather than write, that is worth more here
than an extra feature.

## Licence

By contributing you agree your contribution is licensed under the MIT licence in
[`LICENSE`](LICENSE).
