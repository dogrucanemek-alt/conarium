#!/usr/bin/env node
/**
 * The preprint PDF must carry its own bibliographic metadata.
 *
 * A PDF whose information dictionary is empty is still readable, but a copy of
 * the file that has travelled away from its Zenodo record — in a mailbox, a
 * reference manager, a shared drive — has nothing else to say what it is. The
 * first build shipped `/Title()` and `/Author()`: pdfTeX does not copy `\title`
 * and `\author` into the dictionary, and `hyperref` only does so when told.
 *
 * Three properties are measured:
 *
 *   1. The tex names title, author, subject and keywords once each, and reads
 *      them twice — the title page and `\hypersetup` expand the same macros.
 *      Two hand-typed copies of one string drift; one goes stale and the suite
 *      stays green because each file is self-consistent.
 *   2. `paper/.zenodo.json` — the deposit metadata, and the copy a reader of
 *      the record sees before opening the file — agrees with those names.
 *   3. If a built PDF is present, the dictionary its cross-reference chain
 *      actually points at carries those exact strings. Not any bytes that
 *      happen to appear in the file: the resolved `/Info` object and no other.
 *
 * `paper/build/` is gitignored, so on a fresh clone only 1 and 2 can be
 * measured. The line this prints says which of the three it measured.
 *
 * Release mode refuses that leniency. It takes the artefact by path and by
 * hash, and fails when either is absent:
 *
 *   node test/paper_pdf_metadata.mjs                       # source, and a build if there is one
 *   node test/paper_pdf_metadata.mjs --release <pdf> --sha256 <hex>
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readInfoDict, readOutlineTitles } from './pdf_info_dict.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tex = readFileSync(join(root, 'paper/arxiv/main.tex'), 'utf8')

function argValue(flag) {
  const at = process.argv.indexOf(flag)
  if (at === -1 || at + 1 >= process.argv.length) return null
  const value = process.argv[at + 1]
  return value.startsWith('--') ? null : value
}

function command(name) {
  const match = tex.match(new RegExp(`\\\\newcommand\\{\\\\${name}\\}\\{([^{}]*)\\}`))
  assert.ok(match, `main.tex must define \\${name} — each of these is named once there`)
  const value = match[1].trim()
  assert.ok(value.length > 0, `\\${name} must not be empty`)
  return value
}

const titleFirst = command('papertitlefirst')
const titleSecond = command('papertitlesecond')
const author = command('paperauthorname')
const affiliation = command('paperaffiliation')
const subject = command('papersubject')
const keywords = command('paperkeywords')

const expected = {
  Title: `${titleFirst} ${titleSecond}`,
  Author: author,
  Subject: subject,
  Keywords: keywords,
}

// --- Property 1: one source in the tex, read twice ---------------------------

const wiring = [
  [/\\title\{\s*\\papertitlefirst\\\\\s*\\papertitlesecond\s*\}/,
    'the title page must expand the title macros, not a second hand-typed copy'],
  [/\\author\{\s*\\paperauthorname\\\\\s*\\paperaffiliation\s*\}/,
    'the title page must expand \\paperauthorname and \\paperaffiliation, not hand-typed copies'],
  [/pdftitle=\{\\papertitlefirst\{\}\s\\papertitlesecond\}/,
    'hypersetup pdftitle must expand the same two title macros'],
  [/pdfauthor=\{\\paperauthorname\}/, 'hypersetup pdfauthor must expand the author macro'],
  [/pdfsubject=\{\\papersubject\}/, 'hypersetup pdfsubject must expand the subject macro'],
  [/pdfkeywords=\{\\paperkeywords\}/, 'hypersetup pdfkeywords must expand the keywords macro'],
  // The author name carries a letter outside PDFDocEncoding (ğ). Without the
  // unicode option hyperref cannot write it into the dictionary.
  [/\\usepackage\[[^\]]*\bunicode\b[^\]]*\]\{hyperref\}/,
    'hyperref must be loaded with the unicode option — the author name is not PDFDocEncoding'],
]
for (const [pattern, message] of wiring) assert.ok(pattern.test(tex), message)

// Finding the right \title is not enough. LaTeX takes the last declaration, so
// a second \title further down sets what the page shows while \hypersetup, and
// therefore the dictionary, still reads the macros. The page and the metadata
// would then disagree and both checks above would pass. Each of these may be
// declared once and only once.
for (const [name, count] of [
  ['title', 1], ['author', 1], ['date', 1], ['hypersetup', 1], ['maketitle', 1],
]) {
  const found = [...tex.matchAll(new RegExp(`(?<!\\\\newcommand\\{)\\\\${name}(?![a-zA-Z])`, 'g'))].length
  assert.equal(
    found,
    count,
    `main.tex declares \\${name} ${found} times; the last declaration is the one that ` +
      `takes effect, so more than ${count} means the page and the dictionary can disagree`,
  )
}
// The same hole, reached the other way: redefining a macro after it is read.
const redefined = [...tex.matchAll(/\\renewcommand\{\\paper[a-z]*\}/g)].map((m) => m[0])
assert.equal(
  redefined.length,
  0,
  `these redefine a name the metadata is built from: ${redefined.join(', ')}`,
)

// A bookmark is built from the section title, and LaTeX quoting survives into
// it unless the heading says what the bookmark should read instead. One such
// heading shipped as ``clean'' in the outline of the 24 August build.
const quoted = [...tex.matchAll(/\\(sub)?section\{([^{}]*(?:``|'')[^{}]*)\}/g)]
assert.equal(
  quoted.length,
  0,
  `these headings carry LaTeX quote syntax that would appear verbatim in the PDF outline; ` +
    `give each a \\texorpdfstring with the characters a reader should see:\n  ` +
    quoted.map((m) => m[2]).join('\n  '),
)

// --- Property 2: the deposit metadata agrees --------------------------------

const zenodo = JSON.parse(readFileSync(join(root, 'paper/.zenodo.json'), 'utf8'))
assert.equal(
  zenodo.title,
  expected.Title,
  'paper/.zenodo.json title must be the title the tex names; one of the two has drifted',
)
assert.ok(Array.isArray(zenodo.creators) && zenodo.creators.length > 0, 'paper/.zenodo.json must list creators')
assert.equal(
  zenodo.creators[0].affiliation,
  affiliation,
  'paper/.zenodo.json affiliation must be the affiliation the tex names; ' +
    'the deposit record and the title page would otherwise place the author differently',
)
assert.ok(Array.isArray(zenodo.keywords), 'paper/.zenodo.json must list keywords')
assert.equal(
  zenodo.keywords.join(', '),
  expected.Keywords,
  'paper/.zenodo.json keywords must be the keywords the tex names, in the same order',
)
assert.ok(
  typeof zenodo.license === 'string' && zenodo.license.length > 0,
  'paper/.zenodo.json must name a license',
)
// The licence travels with the file, not only with the record.
const licenceInTex = new RegExp(zenodo.license.replace(/-/g, '[ -]?'), 'i')
assert.ok(
  licenceInTex.test(tex),
  `main.tex must state the ${zenodo.license} licence on the page itself; ` +
    'a PDF copied away from its record otherwise carries no terms',
)

// --- Property 3: the artefact ------------------------------------------------

const releasePath = argValue('--release')
const releaseHash = argValue('--sha256')
if (process.argv.includes('--release') || process.argv.includes('--sha256')) {
  assert.ok(releasePath, '--release needs the path of the PDF that is being published')
  assert.ok(releaseHash, '--release also needs --sha256: the hash the build record names')
  assert.ok(/^[0-9a-f]{64}$/.test(releaseHash), '--sha256 must be 64 lowercase hex characters')
}

const pdfPath = releasePath
  ? (isAbsolute(releasePath) ? releasePath : resolvePath(process.cwd(), releasePath))
  : join(root, 'paper/build/main.pdf')

if (!existsSync(pdfPath)) {
  // Release mode is fail-closed: no artefact, no pass.
  assert.ok(!releasePath, `no PDF at ${pdfPath} — release mode cannot vouch for a file that is not there`)
  console.log(
    `paper pdf metadata GREEN (source and deposit only, no build present) title="${expected.Title}"`,
  )
  process.exit(0)
}

const bytes = readFileSync(pdfPath)
const digest = createHash('sha256').update(bytes).digest('hex')
if (releaseHash) {
  assert.equal(
    digest,
    releaseHash,
    `${pdfPath} is not the file the build record names`,
  )
}

const info = readInfoDict(bytes)
assert.ok(info, `${relative(root, pdfPath) || pdfPath} has no /Info dictionary at all`)
for (const [key, want] of Object.entries(expected)) {
  const got = info[key]
  assert.ok(got !== undefined, `the information dictionary has no /${key}`)
  assert.notEqual(got.trim(), '', `/${key} is present but empty — pdfTeX wrote /${key}()`)
  assert.equal(got, want, `/${key} must read ${JSON.stringify(want)}, not ${JSON.stringify(got)}`)
}

// The outline is the other place the artefact speaks for itself. The tex check
// above looks for quote syntax in headings; this reads what the contents pane
// will actually show, which is the thing that was wrong before anyone looked.
const outline = readOutlineTitles(bytes)
assert.ok(outline.length > 0, 'the PDF has no outline; the headings produced no bookmarks')
const rawSyntax = outline.filter((title) => /``|''|\\[a-zA-Z]+/.test(title))
assert.equal(
  rawSyntax.length,
  0,
  `these bookmark titles carry LaTeX source syntax rather than the characters a reader ` +
    `should see:\n  ${rawSyntax.join('\n  ')}`,
)

const where = releasePath ? pdfPath : relative(root, pdfPath)
console.log(
  `paper pdf metadata GREEN ${where} sha256=${digest.slice(0, 16)}… ` +
    `/Title /Author /Subject /Keywords all resolved from the trailer's /Info`,
)
