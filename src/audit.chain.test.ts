import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { Audit } from './audit.js'
import { computeEntryHash } from './audit-hash.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CHECKER = join(ROOT, 'scripts', 'audit-chain-check.mjs')
const BROKEN_ARCHIVE = join(ROOT, 'conarium-audit-c1.20260724.broken.jsonl')

function runChecker(sink: string): { code: number; json: Record<string, unknown> } {
  try {
    const out = execFileSync(process.execPath, [CHECKER, sink], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, json: JSON.parse(out) }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string }
    return { code: err.status ?? 1, json: JSON.parse(err.stdout || '{}') }
  }
}

describe('audit chain — stale instance (İŞ-17 A1)', () => {
  it('A yazar → B yazar → A tekrar yazar → taze Audit + checker temiz', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conarium-stale-'))
    const sink = join(dir, 'audit.jsonl')
    const A = new Audit({ sink, consumer: 'A' })
    A.log({ tool: 't1', denied: false })
    const B = new Audit({ sink, consumer: 'B' })
    B.log({ tool: 't2', denied: false })
    // Bayat lastHash ile A tekrar yazar — A1 fix yoksa zincir kırılır / taze Audit throw
    expect(() => A.log({ tool: 't3', denied: false })).not.toThrow()
    expect(() => new Audit({ sink })).not.toThrow()
    const chk = runChecker(sink)
    expect(chk.code).toBe(0)
    expect(chk.json.prevHashBreaks).toEqual([])
    expect(chk.json.selfHashMismatches).toEqual([])
    expect(chk.json.lines).toBe(3)
  })
})

describe('audit chain — arşiv bütünlüğü', () => {
  it('broken arşiv: ≥1 prevHash kırığı + 0 self-hash uyuşmazlığı', () => {
    let sink = BROKEN_ARCHIVE
    if (!existsSync(sink)) {
      // Sentetik: self-hash doğru, prevHash yanlış (kurcalama değil — zincir kırığı)
      const dir = mkdtempSync(join(tmpdir(), 'conarium-broken-fix-'))
      sink = join(dir, 'broken.jsonl')
      const a = new Audit({ sink, consumer: 'x' })
      a.log({ tool: 'a', denied: false })
      const e0 = JSON.parse(readFileSync(sink, 'utf-8').trim().split('\n')[0])
      const e1: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        actor: 'y',
        tool: 'b',
        denied: false,
        prevHash: e0.hash.slice(0, 58) + 'aaaaaaaaaa', // wrong prev
      }
      e1.hash = computeEntryHash(e1)
      appendFileSync(sink, JSON.stringify(e1) + '\n')
    }
    const chk = runChecker(sink)
    expect(chk.code).toBe(1)
    expect((chk.json.prevHashBreaks as unknown[]).length).toBeGreaterThanOrEqual(1)
    expect(chk.json.selfHashMismatches).toEqual([])
  })
})
