#!/usr/bin/env node
/**
 * Run every adversarial / check script. One failure does not skip the rest.
 *
 * The old `test:checks` chain used `&&`. When one file failed (macOS
 * `/var` vs `/private/var` in test/init.mjs), the remaining ~20 never ran —
 * the suite was neither green nor red. This runner always finishes the list
 * and prints how many ran, passed, failed, and skipped.
 *
 * Build is a separate step (`npm run build`). This file does not compile.
 *
 *   node test/run-checks.mjs
 *   node test/run-checks.mjs --files a.mjs,b.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const CHECKS = [
  'test/doctor.mjs',
  'test/docker_entry.mjs',
  'test/claim_discipline.mjs',
  'test/locale_letters.mjs',
  'test/locale_allow_strip.mjs',
  'test/threshold_source.mjs',
  'test/claim_source.mjs',
  'test/version_claim.mjs',
  'test/release_record.mjs',
  'test/bin_claims.mjs',
  'test/console_cli.mjs',
  'test/console_policy.mjs',
  'test/console_handoff.mjs',
  'test/console_receipts.mjs',
  'test/console_receipts_tab.mjs',
  'test/console_receipts_first_click.mjs',
  'test/mark_assets.mjs',
  'test/c1_receipt_sink.mjs',
  'test/init.mjs',
  'test/demo_bank_seed.mjs',
  'test/pack_artefakt.mjs',
  'test/connectors.mjs',
  'test/governance_lineage_adversarial.mjs',
  'test/governance_security_regression.mjs',
  'test/property_sql_gate.mjs',
  'test/security_hardening_14.mjs',
  'test/anchor_verify.mjs',
  'test/countersign_verify.mjs',
  'deploy/anchor-service/dry-run.mjs',
  'test/spec_exitcode_drift.mjs',
  'test/encoding_evasion_mask.mjs',
  'test/verify_tail_pin.mjs',
  'test/partial_mask_root.mjs',
  'test/pii_regression_matrix.mjs',
  'test/scanner_perf.mjs',
  'test/vectors_run.mjs',
  'test/http_gateway.e2e.mjs',
  'test/suggest_policy.mjs',
  'test/mint_token_mode.mjs',
  'test/token_sync.mjs',
  'test/token_reload_gate.mjs',
  'test/sync_resilience_gate.mjs',
  'test/run_checks_continue.mjs',
  'test/gacs_import_fence.mjs',
  'test/gacs_case_schema.mjs',
  'test/gacs_regime.mjs',
  'test/gacs_run.mjs',
  'test/gacs_ci_pin.mjs',
  'test/standards_claim.mjs',
]

export function runChecks({ files = CHECKS, cwd = root, spawn = spawnSync } = {}) {
  const results = []
  for (const file of files) {
    const abs = isAbsolute(file) ? file : join(cwd, file)
    if (!existsSync(abs)) {
      results.push({ file, status: 'skipped', detail: 'file missing' })
      continue
    }
    const r = spawn(process.execPath, [abs], { cwd, encoding: 'utf-8' })
    const code = r.status === null ? 1 : r.status
    results.push({
      file,
      status: code === 0 ? 'passed' : 'failed',
      exit: code,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
    })
  }
  return results
}

export function summarize(results) {
  const passed = results.filter((r) => r.status === 'passed').length
  const failed = results.filter((r) => r.status === 'failed').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  return { passed, failed, skipped, ran: passed + failed, total: results.length }
}

export function formatReport(results) {
  const lines = []
  for (const r of results) {
    if (r.status === 'passed') lines.push(`PASS     ${r.file}`)
    else if (r.status === 'failed') {
      lines.push(`FAIL     ${r.file}  exit ${r.exit}`)
      const tail = [r.stdout, r.stderr].filter(Boolean).join('\n').trim()
      if (tail) {
        for (const line of tail.split('\n')) lines.push(`         ${line}`)
      }
    } else lines.push(`SKIPPED  ${r.file}  ${r.detail || 'atlandı'}`)
  }
  const s = summarize(results)
  lines.push('')
  lines.push(`Checks: ${s.ran} ran, ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`)
  return { lines, summary: s, exit: s.failed > 0 ? 1 : 0 }
}

function parseFiles(argv) {
  const i = argv.indexOf('--files')
  if (i >= 0 && argv[i + 1]) {
    return argv[i + 1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return CHECKS
}

function invokedDirectly() {
  const self = resolve(fileURLToPath(import.meta.url))
  const argv1 = process.argv[1] ? resolve(process.argv[1]) : ''
  return self.toLowerCase() === argv1.toLowerCase()
}

if (invokedDirectly()) {
  const files = parseFiles(process.argv.slice(2))
  const results = runChecks({ files, cwd: process.cwd() })
  const report = formatReport(results)
  for (const line of report.lines) console.log(line)
  process.exit(report.exit)
}
