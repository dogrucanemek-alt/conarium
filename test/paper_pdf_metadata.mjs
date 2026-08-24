#!/usr/bin/env node
/**
 * The preprint PDF must carry its own title and author.
 *
 * A PDF whose information dictionary is empty is still readable, but every
 * archive that indexes it — Zenodo, arXiv, a reference manager, a search
 * engine — reads that dictionary, not the title page. The first build shipped
 * `/Title()` and `/Author()`: pdfTeX does not copy `\title` and `\author` into
 * the dictionary, and `hyperref` only does so when it is told to.
 *
 * Two properties are measured here:
 *
 *   1. The tex names the title and the author once and reads them twice — the
 *      title page and `\hypersetup` both expand the same macros. Two hand-typed
 *      copies drift; one of them goes stale and the suite stays green.
 *   2. If a built PDF is present, its dictionary carries those exact strings.
 *      `paper/build/` is gitignored, so on a fresh clone only property 1 can be
 *      measured. The line this prints says which of the two it measured.
 *
 *   node test/paper_pdf_metadata.mjs [path-to-pdf]
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tex = readFileSync(join(root, 'paper/arxiv/main.tex'), 'utf8')

function command(name) {
  const match = tex.match(new RegExp(`\\\\newcommand\\{\\\\${name}\\}\\{([^{}]*)\\}`))
  assert.ok(match, `main.tex must define \\${name} — the title and author are named once there`)
  return match[1]
}

const titleFirst = command('papertitlefirst')
const titleSecond = command('papertitlesecond')
const author = command('paperauthorname')

assert.ok(titleFirst.length > 0 && titleSecond.length > 0, 'title macros must not be empty')
assert.ok(author.length > 0, 'author macro must not be empty')

// Property 1 — one source, read twice.
assert.ok(
  /\\title\{\s*\\papertitlefirst\\\\\s*\\papertitlesecond\s*\}/.test(tex),
  'the title page must expand \\papertitlefirst and \\papertitlesecond, not a second hand-typed copy',
)
assert.ok(
  /\\author\{\s*\\paperauthorname\\\\/.test(tex),
  'the title page must expand \\paperauthorname, not a second hand-typed copy',
)
assert.ok(
  /pdftitle=\{\\papertitlefirst\{\}\s\\papertitlesecond\}/.test(tex),
  'hypersetup pdftitle must expand the same two title macros',
)
assert.ok(
  /pdfauthor=\{\\paperauthorname\}/.test(tex),
  'hypersetup pdfauthor must expand the same author macro',
)
// The author name carries a letter outside PDFDocEncoding (ğ). Without the
// unicode option hyperref cannot write it into the dictionary.
assert.ok(
  /\\usepackage\[[^\]]*\bunicode\b[^\]]*\]\{hyperref\}/.test(tex),
  'hyperref must be loaded with the unicode option — the author name is not PDFDocEncoding',
)

const expectedTitle = `${titleFirst} ${titleSecond}`

// The deposit metadata is the third place the title is written down, and the
// only one a reader of the Zenodo record sees before opening the file. It is
// typed by hand there, so it is compared here rather than trusted.
const zenodo = JSON.parse(readFileSync(join(root, 'paper/.zenodo.json'), 'utf8'))
assert.equal(
  zenodo.title,
  expectedTitle,
  'paper/.zenodo.json title must be the title the tex names; one of the two has drifted',
)

// Property 2 — the built artefact, when there is one.
const argPath = process.argv[2]
const pdfPath = argPath
  ? (isAbsolute(argPath) ? argPath : join(process.cwd(), argPath))
  : join(root, 'paper/build/main.pdf')

if (!existsSync(pdfPath)) {
  assert.ok(!argPath, `no PDF at ${pdfPath}`)
  console.log(
    `paper pdf metadata GREEN (source only, no build present) ` +
      `title="${expectedTitle}" author="${author}"`,
  )
  process.exit(0)
}

const bytes = readFileSync(pdfPath)
const raw = bytes.toString('latin1')

const SHORTHAND = { n: 0x0a, r: 0x0d, t: 0x09, b: 0x08, f: 0x0c }

/** Undo the escaping of a PDF literal string, byte for byte. */
function unescapeLiteral(body) {
  const bytes = []
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') {
      bytes.push(body.charCodeAt(i) & 0xff)
      continue
    }
    const next = body[(i += 1)]
    if (next === undefined) break
    if (next >= '0' && next <= '7') {
      // \ddd — one to three octal digits. This is how pdfTeX writes every
      // byte of a UTF-16BE string, the BOM included.
      let octal = next
      while (octal.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') octal += body[(i += 1)]
      bytes.push(parseInt(octal, 8) & 0xff)
    } else if (SHORTHAND[next] !== undefined) {
      bytes.push(SHORTHAND[next])
    } else if (next === '\n') {
      // a backslash at end of line continues the string; it adds nothing
    } else if (next === '\r') {
      if (body[i + 1] === '\n') i += 1
    } else {
      bytes.push(body.charCodeAt(i) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

/** A text string is UTF-16BE when it opens with a byte order mark. */
function decodeTextString(buf) {
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2))
    if (body.length % 2 === 1) body.writeUInt8(0, body.length - 1)
    return body.swap16().toString('utf16le')
  }
  return buf.toString('latin1')
}

function pdfString(key) {
  // hyperref writes a literal string or a hex string, and with the unicode
  // option the bytes inside are UTF-16BE. Read whichever this file carries.
  const re = new RegExp(`/${key}\\s*(?:\\(((?:\\\\[\\s\\S]|[^\\\\)])*)\\)|<([0-9A-Fa-f\\s]*)>)`, 'g')
  const found = []
  for (const match of raw.matchAll(re)) {
    const buf = match[1] !== undefined
      ? unescapeLiteral(match[1])
      : Buffer.from(match[2].replace(/\s+/g, ''), 'hex')
    found.push(decodeTextString(buf))
  }
  assert.ok(found.length > 0, `${relative(root, pdfPath)} has no /${key} entry at all`)
  return found
}

for (const [key, expected] of [['Title', expectedTitle], ['Author', author]]) {
  const found = pdfString(key)
  assert.ok(
    !found.every((value) => value.trim() === ''),
    `/${key} is present but empty in ${relative(root, pdfPath)} — pdfTeX wrote /${key}()`,
  )
  assert.ok(
    found.includes(expected),
    `/${key} must read ${JSON.stringify(expected)}; the file carries ${JSON.stringify(found)}`,
  )
}

console.log(
  `paper pdf metadata GREEN ${relative(root, pdfPath) || pdfPath} ` +
    `/Title="${expectedTitle}" /Author="${author}"`,
)
