#!/usr/bin/env node
/**
 * GACS runner. Product-neutral: talks to an adapter process and, for
 * receipt cases, to whatever verifier the claims file names.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  claimed,
  conformanceStatus,
  label,
  noScore,
} from './lib/status.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

function parseArgv(argv) {
  const out = { adapter: '', claims: '', only: '', outDir: HERE }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--adapter') out.adapter = argv[++i]
    else if (a === '--claims') out.claims = argv[++i]
    else if (a === '--only') out.only = argv[++i]
    else if (a === '--out') out.outDir = argv[++i]
  }
  if (!out.adapter || !out.claims) {
    process.stderr.write('usage: run.mjs --adapter <path> --claims <path> [--only <class|profile|id>] [--out <dir>]\n')
    process.exit(2)
  }
  return out
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.json')) acc.push(p)
  }
  return acc
}

function loadCases(only) {
  const files = walk(join(HERE, 'cases'))
  const cases = files.map((f) => JSON.parse(readFileSync(f, 'utf8')))
  if (!only) return cases
  return cases.filter((c) => c.id === only || c.id.startsWith(`${only}/`) || c.profile === only)
}

function resolveKeys(args) {
  return args.map((a) => a.replaceAll('KEYS/', join(REPO, 'test-vectors', 'keys') + '/'))
}

function runAdapter(adapter, policyPath, sql) {
  const dir = mkdtempSync(join(tmpdir(), 'gacs-'))
  const q = join(dir, 'query.sql')
  writeFileSync(q, sql)
  const r = spawnSync(process.execPath, [adapter, '--policy', policyPath, '--query', q], {
    encoding: 'utf8',
    cwd: REPO,
    windowsHide: true,
  })
  if (r.status !== 0) {
    return { toolFailure: true, detail: (r.stderr || r.stdout || `exit ${r.status}`).trim() }
  }
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop()
  try {
    return { toolFailure: false, result: JSON.parse(line) }
  } catch {
    return { toolFailure: true, detail: 'adapter stdout was not one JSON object' }
  }
}

function runVerify(claims, c) {
  const cmd = claims.verify
  if (!Array.isArray(cmd) || cmd.length === 0) {
    return { toolFailure: true, detail: 'claims.verify is missing' }
  }
  const bin = cmd[0] === 'node' ? process.execPath : cmd[0]
  const receipt = resolve(REPO, c.receipt)
  const args = [...cmd.slice(1), receipt, ...resolveKeys(c.verifyArgs || [])]
  const r = spawnSync(bin, args, { encoding: 'utf8', cwd: REPO, windowsHide: true })
  return { toolFailure: false, exit: r.status ?? 1 }
}

function resistanceStatusFor(c, empirical, claimsFile) {
  const listed = claimed(claimsFile, c.claim)
  if (c.expectedStatus === 'DECLARED_ONLY' || c.expectedStatus === 'DETECTED_WITH_EXTERNAL_PIN') {
    return c.expectedStatus
  }
  if (c.expectedStatus === 'BOUNDED') return 'BOUNDED'
  if (c.expectedStatus === 'NOT_COVERED') return empirical.denied ? 'ENFORCED' : 'NOT_COVERED'
  if (!listed) return 'NOT_CLAIMED'
  return empirical.denied ? 'ENFORCED' : 'NOT_COVERED'
}

function evaluate(c, claimsFile, adapter) {
  const row = {
    id: c.id,
    regime: c.regime,
    profile: c.profile,
    claim: c.claim,
    rationale: c.rationale,
    doesNotTest: c.doesNotTest,
    expectedFail: Boolean(c.expectedFail),
    expectedStatus: c.expectedStatus || null,
  }

  if ((c.harness || 'query') === 'verify') {
    const v = runVerify(claimsFile, c)
    if (v.toolFailure) return { ...row, status: 'TOOL_FAILURE', detail: v.detail, unexpected: true }
    const ok = v.exit === c.expectExit
    if (c.regime === 'conformance') {
      const status = label('conformance', conformanceStatus({ ok }))
      const unexpected = status === 'FAIL' && claimed(claimsFile, c.claim)
      return { ...row, status, exit: v.exit, unexpected }
    }
    const status = label('resistance', resistanceStatusFor(c, { denied: v.exit !== 0 }, claimsFile))
    return { ...row, status, exit: v.exit, unexpected: staleGap(c, status) }
  }

  const policyPath = resolve(HERE, c.policy)
  const ran = runAdapter(adapter, policyPath, c.query)
  if (ran.toolFailure) return { ...row, status: 'TOOL_FAILURE', detail: ran.detail, unexpected: true }
  const decision = ran.result.decision
  const denied = decision === 'deny'

  if (c.regime === 'conformance') {
    let ok = decision === c.expect
    if (ok && c.expectRewritten) {
      ok = new RegExp(c.expectRewritten, 'i').test(ran.result.rewrittenSql || '')
    }
    if (ok && c.expectMaskedContains) {
      const fields = (ran.result.maskedFields || []).map((f) => String(f).toLowerCase())
      ok = fields.includes(String(c.expectMaskedContains).toLowerCase())
    }
    const status = label('conformance', conformanceStatus({ ok }))
    const unexpected = status === 'FAIL' && claimed(claimsFile, c.claim)
    return { ...row, status, decision, unexpected }
  }

  const status = label('resistance', resistanceStatusFor(c, { denied }, claimsFile))
  return { ...row, status, decision, unexpected: staleGap(c, status) }
}

function staleGap(c, status) {
  if (!c.expectedFail) return false
  if (c.expectedStatus === 'NOT_COVERED' && status === 'ENFORCED') return true
  if (c.expectedStatus && status !== c.expectedStatus && status === 'ENFORCED') return true
  return false
}

function implementationVersion(claimsFile) {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
  if (Object.hasOwn(claimsFile, 'version')) {
    throw new Error(
      'conformance/claims must not declare version — it is derived from package.json. ' +
        'A second hand-written copy is how 0.2.20 sat next to 0.2.28.',
    )
  }
  return { implementation: claimsFile.implementation, version: pkg.version }
}

function renderMd(claimsFile, rows) {
  const { implementation, version } = implementationVersion(claimsFile)
  const lines = [`# GACS report for ${implementation} ${version}`, '']
  const profiles = ['GACS-D1', 'GACS-E1', 'GACS-C1', 'GACS-I1']
  for (const profile of profiles) {
    const slice = rows.filter((r) => r.profile === profile)
    if (slice.length === 0) continue
    lines.push(`## ${profile}`)
    lines.push('')
    for (const r of slice) {
      lines.push(`- \`${r.id}\` — ${r.status}`)
      if (r.status !== 'PASS') {
        lines.push(`  - rationale: ${r.rationale}`)
        lines.push(`  - doesNotTest: ${r.doesNotTest}`)
      }
    }
    lines.push('')
  }
  lines.push('No single score is produced.')
  lines.push('')
  return lines.join('\n')
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgv(argv)
  const adapter = resolve(REPO, opts.adapter)
  const claimsFile = JSON.parse(readFileSync(resolve(REPO, opts.claims), 'utf8'))
  const ident = implementationVersion(claimsFile)
  const cases = loadCases(opts.only)
  const rows = cases.map((c) => evaluate(c, claimsFile, adapter))
  const report = {
    implementation: ident.implementation,
    version: ident.version,
    title: `GACS report for ${ident.implementation} ${ident.version}`,
    results: rows,
  }
  noScore(report)
  for (const r of rows) {
    if (r.regime === 'resistance' && r.status === 'PASS') {
      throw new Error(`${r.id}: resistance printed PASS`)
    }
  }

  mkdirSync(opts.outDir, { recursive: true })
  writeFileSync(join(opts.outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(join(opts.outDir, 'report.md'), renderMd(claimsFile, rows))

  const unexpected = rows.filter((r) => r.unexpected)
  const tools = rows.filter((r) => r.status === 'TOOL_FAILURE')
  process.stdout.write(renderMd(claimsFile, rows))
  if (tools.length || unexpected.length) process.exit(1)
  process.exit(0)
}

main()
