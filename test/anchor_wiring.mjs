#!/usr/bin/env node
/**
 * Automatic-anchoring claims must have a production write call.
 *
 * Four times (0.2.31 / 0.2.33 / 0.2.35 / this sentence) a claim surface
 * asserted a mechanism that existed as a library and was never called from
 * the receipt write path. `Audit.writeReceipt` emits `anchor: null` and
 * does not invoke the scheduler. `CONARIUM_ANCHOR_SINK` is normalized in
 * `src/config.ts` and read by `createAnchorSinkFromEnv` — a function whose
 * only production-shaped callers, on the tree this check first ran against,
 * were its own definition and the unit tests.
 *
 * This file does not wire the scheduler. Wiring it is a product decision:
 * it adds an outbound network hop to the receipt path and changes the
 * "two outbound connections" list in docs/ARCHITECTURE.md. The check's
 * job is to refuse the claim unless a write call exists.
 *
 *   claims present, no write call  →  exit 1
 *   claims present, write call     →  exit 0
 *   no claims, no write call       →  exit 0  (text matches the mechanism)
 *
 * A write call is an invocation of maybeAnchor, appendAnchorSidecar,
 * createAnchorSinkFromEnv, or `new AnchorScheduler` in src/ or bin/,
 * excluding tests and excluding the definitions in src/anchor.ts.
 * `conarium-stamp` writes a document sidecar via stampHash; that is a
 * manual tool, not receipt-path wiring, and does not count.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Surfaces a reader can take as a promise about anchoring. Includes the
 * stamp tool header: that file is published in `bin` and repeated the
 * same sentence the spec used.
 */
const CLAIM_SURFACES = [
  'README.md',
  'README.tr.md',
  'LIMITATIONS.md',
  'LIMITATIONS.tr.md',
  'docs.html',
  'docs/ARCHITECTURE.md',
  'docs/RECEIPT-SPEC.md',
  'bin/conarium-stamp.mjs',
]

/**
 * Phrasings that tell a reader receipts are stamped as they are written,
 * or that setting the sink env is enough. Honest sentences that name the
 * manual tools, or that say receipts are born with `anchor: null`, do
 * not match.
 */
const AUTOMATIC_CLAIM = [
  {
    id: 'anchored-automatically',
    re: /anchored automatically/i,
    why: 'the write path does not stamp; conarium-stamp / conarium-anchor-service do',
  },
  {
    id: 'receipts-already-pending',
    re: /receipts already show\s+`?pending`?/i,
    why: 'receipts are born with anchor:null; pending appears only after a stamp is submitted',
  },
  {
    id: 'env-stamps-receipts',
    re: /opt-in anchoring:\s*`?CONARIUM_ANCHOR_SINK/i,
    why: 'the env selects a calendar client; it does not stamp receipts as they are written',
  },
  {
    id: 'pending-already-visible-tr',
    re: /makbuzda `pending` zaten görünür|makbuz `pending` gösterir/i,
    why: 'same as receipts-already-pending, on the Turkish limitations surface',
  },
]

const WRITE_CALL = /(?:maybeAnchor|appendAnchorSidecar|createAnchorSinkFromEnv)\s*\(|new\s+AnchorScheduler\s*\(/
const WRITE_DEFINITION =
  /(?:export\s+)?(?:async\s+)?(?:function|class)\s+(?:maybeAnchor|appendAnchorSidecar|createAnchorSinkFromEnv|AnchorScheduler)\b|async\s+maybeAnchor\s*\(/

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full, acc)
      continue
    }
    if (!/\.(ts|mjs)$/.test(name)) continue
    if (/\.test\.(ts|mjs)$/.test(name)) continue
    acc.push(full)
  }
  return acc
}

function scanClaims() {
  const hits = []
  for (const rel of CLAIM_SURFACES) {
    const path = join(root, rel)
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      for (const rule of AUTOMATIC_CLAIM) {
        if (rule.re.test(line)) {
          hits.push({ file: rel, line: i + 1, id: rule.id, why: rule.why, text: line.trim() })
        }
      }
    })
  }
  return hits
}

function scanWriteCalls() {
  const files = [...walk(join(root, 'src')), ...walk(join(root, 'bin'))]
  const calls = []
  for (const full of files) {
    const rel = relative(root, full).replaceAll('\\', '/')
    const lines = readFileSync(full, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!WRITE_CALL.test(line)) return
      if (WRITE_DEFINITION.test(line)) return
      if (rel === 'src/anchor.ts') return
      calls.push({ file: rel, line: i + 1, text: line.trim() })
    })
  }
  return calls
}

const claims = scanClaims()
const calls = scanWriteCalls()

if (claims.length > 0 && calls.length === 0) {
  console.error('anchor wiring: claim surfaces assert automatic receipt anchoring, but src/ and bin/ (excluding tests and src/anchor.ts definitions) have no write call')
  for (const h of claims) {
    console.error(`  CLAIM  ${h.file}:${h.line}  [${h.id}]  ${h.text}`)
    console.error(`         ${h.why}`)
  }
  console.error('  WRITE  (none)')
  process.exit(1)
}

if (claims.length > 0) {
  console.log(`anchor wiring: ${claims.length} automatic-anchor claim(s) matched by ${calls.length} write call(s)`)
  for (const c of calls) console.log(`  WRITE  ${c.file}:${c.line}  ${c.text}`)
} else {
  console.log('anchor wiring: no automatic-anchor claim on the scanned surfaces; write-path wiring is not required')
}
process.exit(0)
