#!/usr/bin/env node
/**
 * Sentence-length pass for Internet-Draft markdown (kramdown-rfc).
 *
 * Prints: total sentences, sentences over 25 words, how many of those
 * carry a BCP 14 keyword, how many do not, and the share of sentences
 * that carry a BCP 14 keyword.
 *
 * Excluded from the count: YAML front matter, fenced code blocks,
 * markdown tables, the BCP 14 boilerplate directive, and a References
 * heading plus what follows it (kramdown-rfc emits that from the
 * front matter; a hand-written one is excluded too).
 *
 * Usage: node test/draft_sentences.mjs <path-to.md>
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BCP14 = /\b(MUST(?:\s+NOT)?|SHALL(?:\s+NOT)?|SHOULD(?:\s+NOT)?|MAY|REQUIRED|RECOMMENDED|NOT RECOMMENDED|OPTIONAL)\b/

const ABBREV = [
  'e.g',
  'i.e',
  'cf',
  'vs',
  'etc',
  'Mr',
  'Ms',
  'Mrs',
  'Dr',
  'Prof',
  'Fig',
  'Sec',
  'No',
  'al',
  'Ed',
]

function stripExcluded(raw) {
  let text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const abs = text.search(/^--- abstract\s*$/m)
  if (abs !== -1) text = text.slice(abs)
  else text = text.replace(/^---\n[\s\S]*?\n---\n/, '\n')
  // kramdown-rfc section sentinels
  text = text.replace(/^--- (abstract|middle|back|note)\s*$/gim, '\n')
  // Fenced code
  text = text.replace(/```[\s\S]*?```/g, '\n')
  // BCP 14 boilerplate (the RFC 2119 paragraph is generated, not counted)
  text = text.replace(/\{::boilerplate[^}]*\}/g, '\n')
  text = text.replace(/\{:[^}]*\}/g, '\n')
  // Tables
  text = text.replace(/^\|.*$/gm, '')
  // Drop a References section if one is written in (usually generated)
  text = text.replace(/\n#+\s+References\b[\s\S]*$/i, '\n')
  // kramdown link targets and comment-ish leftovers
  text = text.replace(/^\s*\[.*?\]:\s+\S+.*$/gm, '')
  return text
}

function protectAbbrevs(text) {
  let out = text
  for (const a of ABBREV) {
    const re = new RegExp(`\\b${a.replace('.', '\\.')}\\.`, 'g')
    out = out.replace(re, `${a}<ABBR>`)
  }
  // RFC / BCP numbers: "RFC 8785." at sentence end stays; "RFC 8785," is fine.
  // Decimal versions like 0.2.38 — protect inner dots
  out = out.replace(/\b(\d+)\.(\d+)\.(\d+)\b/g, '$1<DOT>$2<DOT>$3')
  out = out.replace(/\b(\d+)\.(\d+)\b/g, '$1<DOT>$2')
  return out
}

function restore(text) {
  return text.replace(/<ABBR>/g, '.').replace(/<DOT>/g, '.')
}

function splitSentences(text) {
  const protectedText = protectAbbrevs(text)
  // Collapse definition-list markup and heading hashes into spaces so
  // they do not glue words.
  const flat = protectedText
    .replace(/^#+\s+/gm, '')
    .replace(/`+/g, '')
    .replace(/\{\{[^}]+\}\}/g, ' X ')
    .replace(/\[([^\]]+)\]/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[_*]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')

  const parts = []
  let buf = ''
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i]
    buf += ch
    if (ch === '.' || ch === '?' || ch === '!') {
      const next = flat[i + 1]
      if (next === undefined || next === ' ' || next === '\n') {
        const s = restore(buf).replace(/\s+/g, ' ').trim()
        if (s.length > 1) parts.push(s)
        buf = ''
      }
    }
  }
  const tail = restore(buf).replace(/\s+/g, ' ').trim()
  if (tail.length > 1) parts.push(tail)
  return parts.filter((s) => /[A-Za-z]/.test(s))
}

function words(sentence) {
  return sentence
    .replace(/[^A-Za-z0-9'/-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('Usage: node test/draft_sentences.mjs <md>')
    process.exit(2)
  }
  const raw = readFileSync(resolve(file), 'utf8')
  const sentences = splitSentences(stripExcluded(raw))
  const long = []
  let normative = 0
  for (const s of sentences) {
    const n = words(s).length
    const bcp = BCP14.test(s)
    if (bcp) normative += 1
    if (n > 25) long.push({ n, bcp, s })
  }
  const longBcp = long.filter((x) => x.bcp).length
  const longPlain = long.length - longBcp
  const pct = sentences.length ? (100 * normative) / sentences.length : 0

  const list = process.argv.includes('--list')
  console.log(
    JSON.stringify(
      {
        file,
        sentences: sentences.length,
        over25: long.length,
        over25_bcp14: longBcp,
        over25_non_normative: longPlain,
        normative_sentences: normative,
        normative_pct: Number(pct.toFixed(1)),
      },
      null,
      2,
    ),
  )
  if (list) {
    for (const row of long.filter((x) => !x.bcp)) {
      console.error(`${row.n}\t${row.s}`)
    }
  }
}

main()
