#!/usr/bin/env node
/**
 * The release note for a version, read out of CHANGELOG.md.
 *
 * 0.2.33 was published to npm on 2026-08-19 with a git tag, no GitHub release,
 * and a tarball whose newest changelog entry was 0.2.32. The 0.2.32 entry had
 * announced that exact defect as fixed — "a file that ships in the tarball and
 * describes a state the package left two releases ago is worse than no file" —
 * and it came back one release later, because the fix was an edit rather than
 * something that had to happen.
 *
 * Two hand-written records of one release drift apart; one derived from the
 * other cannot. So the release note is not written twice. The changelog section
 * is the note, this reads it, and the publish workflow refuses to release a
 * version that has none.
 *
 *   node .github/scripts/release-notes.mjs 0.2.34 --body
 *   node .github/scripts/release-notes.mjs 0.2.34 --title
 *
 * Headings are `## <version> — <date>`, optionally followed by a third segment
 * that becomes the release title:
 *
 *   ## 0.2.34 — 2026-08-20 — the pin that nobody was advancing
 *
 * Without one the title is `Conarium <version>`, which is accurate but says
 * nothing; the segment exists so a release can be named after what it changed.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HEADING = /^##\s+(\d+\.\d+\.\d+)\b(.*)$/

/** Every `## <version>` section in a changelog, keyed by version. */
export function sections(markdown) {
  const lines = markdown.split(/\r?\n/)
  const found = new Map()
  let current = null
  for (const line of lines) {
    const m = HEADING.exec(line)
    if (m) {
      current = { version: m[1], rest: m[2], body: [] }
      // A version repeated in the changelog would silently take whichever copy
      // the loop saw last. Refuse instead: the file already disagrees with
      // itself and picking one is guessing which half is true.
      if (found.has(m[1])) throw new Error(`CHANGELOG.md declares ${m[1]} more than once`)
      found.set(m[1], current)
      continue
    }
    if (current) current.body.push(line)
  }
  return found
}

export function noteFor(markdown, version) {
  const section = sections(markdown).get(version)
  if (!section) {
    throw new Error(
      `CHANGELOG.md has no "## ${version}" section.\n\n` +
        `  A release with no note is not a smaller release, it is an unrecorded one.\n` +
        `  Write the section, then publish.\n`,
    )
  }
  const body = section.body.join('\n').trim()
  if (!body) throw new Error(`the "## ${version}" section in CHANGELOG.md is empty`)
  // ` — 2026-08-20 — the title`  ->  `the title`
  const extra = section.rest.split('—').slice(2).join('—').trim()
  return { title: extra ? `Conarium ${version} — ${extra}` : `Conarium ${version}`, body }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const [version, mode = '--body'] = process.argv.slice(2)
  if (!version) {
    console.error('usage: release-notes.mjs <version> [--body|--title]')
    process.exit(2)
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  let note
  try {
    note = noteFor(readFileSync(join(root, 'CHANGELOG.md'), 'utf-8'), version)
  } catch (err) {
    console.error(`::error::${err.message.split('\n')[0]}`)
    console.error(err.message)
    process.exit(1)
  }
  process.stdout.write(mode === '--title' ? `${note.title}\n` : `${note.body}\n`)
}
