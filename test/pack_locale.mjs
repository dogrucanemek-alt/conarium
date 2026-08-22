#!/usr/bin/env node
/**
 * Files npm ships must not carry Turkish — neither its letters nor its words.
 *
 * A stranger installing the package was reading fail-closed messages in
 * Turkish. The letters are the defect: if they appear in a packed file,
 * the next operator will see them. This check asks npm what it would
 * ship, then reads those files. A hand-written file list would miss the
 * next path the way the old pin check missed seven workflows.
 *
 * Allowed, and only these:
 *   - `*.tr.md` — the Turkish copy of a document, on purpose
 *   - measured PII examples and registered legal names (same residue as
 *     locale_letters)
 *   - detector tokens that match Turkish PII in customer data
 *   - the default pseudonym prefix `Kayıt` (renaming it would change maps)
 * Scope is the code a stranger runs: `dist/`, `bin/`, `scripts/`, `public/`.
 * Historical notes under `docs/` and CHANGELOG are a different surface
 * (locale_letters already watches the published English pages).
 *
 * The allow-list is not a place to grow. A new Turkish file belongs in
 * `*.tr.md` or it does not ship.
 *
 * ⚠️ The letter pass finds letters, not language. Turkish written without
 * ç ğ ı ö ş ü walks straight through it — which is what happened: the
 * package this check declared clean still shipped `SURUMLER`, `alan` and
 * `dolu` as identifiers in the independent verifier a stranger is invited
 * to read, plus paragraphs of Turkish reasoning in `iban` and `init`.
 * So there is a second pass over the same scope, looking for words.
 *
 * The word list is deliberately small and deliberately excludes anything
 * that is also English (`once`, `not`, `var`, `sil`) — a check that cries
 * wolf on English prose gets switched off. It is not a language detector
 * and does not pretend to be one; it catches the vocabulary this codebase
 * actually reached for. Scope is the same `dist|bin|scripts|public`:
 * `docs/` still carries Turkish design history, counted and reported below
 * rather than silently passed over.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localeResidue } from './claim_discipline.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LETTERS = /[çğıöşüÇĞİÖŞÜ]/
const TEXT = /\.(?:js|mjs|cjs|ts|json|md|html|css|sql|txt|map|yml|yaml|xml|svg)$/i

/** Tokens the PII detectors must keep matching. Not interface language. */
const DETECTOR = [
  /Sayın/g,
  /müşteri/g,
  /kişi/g,
  /adı soyadı/g,
  /Yılmaz/g,
  /Ayşe/g,
  /Ahmet/g,
  /Kayıt/g,
  /"ş"/g,
]

function packedFiles() {
  const out = execFileSync('npm pack --dry-run --json', {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  })
  const parsed = JSON.parse(out.trim())
  const listing = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]]
  assert.ok(listing?.files?.length, 'npm pack --dry-run returned no file list')
  return listing.files.map((f) => f.path.replace(/\\/g, '/'))
}

const SCOPE = /^(dist|bin|scripts|public)\//

/**
 * Turkish words that carry no Turkish-specific letter, so the letter pass
 * cannot see them. Anything that is also an English word stays out.
 */
const WORDS = [
  'alan', 'alanlar', 'anahtar', 'basarili', 'basarisiz', 'baslat', 'beklenen',
  'bitir', 'bulunamadi', 'bulundu', 'deger', 'degerler', 'dolu', 'dosya',
  'eksik', 'eski', 'gecerli', 'gecersiz', 'gelen', 'giden', 'guncelle', 'hata',
  'imza', 'islem', 'kayit', 'kontrol', 'kural', 'kurallar', 'liste', 'olustur',
  'bildirilmemis', 'notlar', 'ornek', 'sayi', 'satir', 'sonra', 'sonuc', 'surum',
  'surumler', 'tarih',
  'toplam', 'uyari', 'varsayilan', 'yani', 'yazildi', 'yeni', 'yoksa',
  'zorunlu',
]
const WORD_RE = new RegExp(`\\b(?:${WORDS.join('|')})\\b`, 'i')

function allowedFile(rel) {
  if (rel.endsWith('.tr.md')) return true
  return !SCOPE.test(rel)
}

function residue(line) {
  let text = localeResidue(line)
  for (const re of DETECTOR) text = text.replace(re, '')
  return text
}

function hitsIn(rel, probe) {
  if (allowedFile(rel)) return []
  if (!TEXT.test(extname(rel)) && !rel.endsWith('package.json')) return []
  const raw = readFileSync(join(root, rel), 'utf-8')
  const found = []
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    const hit = probe(line)
    if (!hit) continue
    found.push(`${rel}:${i + 1}${typeof hit === 'string' ? ` (${hit})` : ''}`)
    if (found.length >= 20) break
  }
  return found
}

const letterProbe = (line) => LETTERS.test(residue(line))

const wordProbe = (line) => {
  const m = WORD_RE.exec(line)
  return m ? m[0] : false
}

/**
 * Turkish under `docs/` is out of scope on purpose — but an unreported
 * remainder reads as "there is none". Counted, so it stays visible.
 *
 * ⚠️ This ran `wordProbe` alone until 0.2.43, and `wordProbe` is the pass
 * written for Turkish that carries no Turkish letter. Over `docs/` — which is
 * Turkish prose, letters and all — it is the wrong instrument: it reported 324
 * lines across 22 files where the letter pass finds 1041 across 29. The number
 * whose whole job was to keep the remainder visible was showing a third of it,
 * and it read as the total because nothing beside it disagreed. Both probes
 * now run, and the union is what gets printed and pinned.
 */
function docsRemainder(packed) {
  let hits = 0
  let touched = 0
  const files = []
  for (const rel of packed) {
    if (SCOPE.test(rel) || rel.endsWith('.tr.md')) continue
    if (!TEXT.test(extname(rel))) continue
    let raw
    try {
      raw = readFileSync(join(root, rel), 'utf-8')
    } catch {
      continue
    }
    let n = 0
    for (const line of raw.split(/\r?\n/)) if (letterProbe(line) || wordProbe(line)) n++
    if (n) {
      hits += n
      touched++
      files.push(rel)
    }
  }
  return { hits, touched, files: files.sort() }
}

const files = packedFiles()
const letterHits = files.flatMap((rel) => hitsIn(rel, letterProbe))
const wordHits = files.flatMap((rel) => hitsIn(rel, wordProbe))

if (letterHits.length) {
  console.error(
    `pack locale RED — Turkish-specific letters in packed files:\n  ${letterHits.join('\n  ')}`,
  )
}
if (wordHits.length) {
  console.error(
    `pack locale RED — Turkish words in packed files (no Turkish letter in them, which is why\n` +
      `the letter pass missed this class):\n  ${wordHits.join('\n  ')}`,
  )
}
if (letterHits.length || wordHits.length) process.exit(1)

const remainder = docsRemainder(files)
console.log(
  `pack locale GREEN — ${files.length} packed path(s); 0 Turkish letters and 0 Turkish words ` +
    `in dist/bin/scripts/public`,
)
console.log(
  `  out of scope, not fixed: ${remainder.hits} Turkish line(s) across ` +
    `${remainder.touched} packed doc file(s) under docs/ and the changelog`,
)

/**
 * A reported number nobody compares against anything drifts silently — which is
 * the defect above, and it survived three releases because the figure was
 * printed, copied into a handover note, and never asked to agree with the tree.
 *
 * So the remainder is pinned. The pin is a ceiling, not a target: it may be
 * lowered whenever Turkish leaves the package and it must be edited
 * deliberately when a file is added. Growth is what it refuses.
 */
const PIN = JSON.parse(readFileSync(join(root, 'docs/claims/locale-residue.json'), 'utf-8'))

const drifted = remainder.hits !== PIN.lines || remainder.touched !== PIN.files
if (drifted) {
  const grew = remainder.hits > PIN.lines || remainder.touched > PIN.files
  console.error(
    `pack locale RED — the docs remainder is pinned at ${PIN.lines} line(s) across ` +
      `${PIN.files} file(s); the tree has ${remainder.hits} across ${remainder.touched}.`,
  )
  console.error(
    grew
      ? '  Turkish grew inside the package. Put the text in a *.tr.md file, or keep the\n' +
          '  path out of the "files" list in package.json. Raising the pin is the last resort.'
      : '  Turkish left the package — lower the pin in docs/claims/locale-residue.json to\n' +
          '  the numbers above, so the next growth is still visible.',
  )
  console.error(`  files carrying it:\n    ${remainder.files.join('\n    ')}`)
  process.exit(1)
}
console.log(`  remainder pinned at ${PIN.lines}/${PIN.files} — ${PIN.why}`)
