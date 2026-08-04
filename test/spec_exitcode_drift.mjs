// test/spec_exitcode_drift.mjs
// Drift guard: ensure literal CLI exit codes match the markdown table in docs.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here     = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const SRC_PATH  = path.join(repoRoot, 'bin', 'conarium-verify.mjs');
const DOCS_PATH = path.join(repoRoot, 'docs', 'RECEIPT-SPEC.md');

// Collect literal exit-code integers from the CLI source. Three patterns,
// all /g, all multiline-friendly so a `fail(` followed by a number on the
// next line is still caught.
function codesInCode(text) {
  const out = new Set();
  const patterns = [
    /process\.exit\(\s*(\d+)\s*\)/g,
    /\bfail\(\s*(\d+)/g,
    /\bcode:\s*(\d+)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

// Parse the markdown table: keep only rows whose first cell is entirely digits.
function codesInDocs(text) {
  const out = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim()).filter(Boolean);
    const first = cells[0];
    if (first !== undefined && /^\d+$/.test(first)) out.add(Number(first));
  }
  return [...out].sort((a, b) => a - b);
}

const sourceText  = readFileSync(SRC_PATH, 'utf8');
const docsText    = readFileSync(DOCS_PATH, 'utf8');
const codeNumbers = codesInCode(sourceText);
const docNumbers  = codesInDocs(docsText);

const codeSet = new Set(codeNumbers);
const docSet  = new Set(docNumbers);

const undocumented = codeNumbers.filter(n => !docSet.has(n));
const stale        = docNumbers.filter(n => !codeSet.has(n));

// This note is written in EVERY case, success or failure.
process.stderr.write(
  'NOTE: only literal numeric exit codes are scanned; codes passed through variables are out of scope\n',
);

if (undocumented.length === 0 && stale.length === 0) {
  const union = [...new Set([...codeNumbers, ...docNumbers])].sort((a, b) => a - b);
  process.stdout.write(`ok: exit codes in sync (${union.join(',')})\n`);
  process.exit(0);
}

for (const n of undocumented) {
  process.stderr.write(`UNDOCUMENTED exit code ${n} in bin/conarium-verify.mjs\n`);
}
for (const n of stale) {
  process.stderr.write(`STALE exit code ${n} in docs/RECEIPT-SPEC.md\n`);
}
process.exit(1);
