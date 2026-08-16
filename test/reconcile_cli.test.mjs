/**
 * test/reconcile_cli.test.mjs
 *
 * CLI davranış testleri — conarium-reconcile alt süreç olarak çalıştırılır.
 * Desen: coverage_cli.test.mjs (vitest + execFileSync + el yazısı fixture).
 * ZERO imports from src/ — saf fonksiyonlar bin dosyasından import edilir.
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const RECONCILE = fileURLToPath(new URL('../bin/conarium-reconcile.mjs', import.meta.url))
const { extractTables, classifyPattern, reconcile } = await import(RECONCILE)

// ─── helpers ─────────────────────────────────────────────────────────────────

const T0 = '2026-08-06T10:00:00.000Z'
const T1 = '2026-08-06T12:00:00.000Z'
const IN_WINDOW = '2026-08-06T11:00:00.000Z'
const BEFORE_WINDOW = '2026-08-06T09:00:00.000Z'

// PostgREST'in gerçekte ürettiği desen sınıfı (canlıdan kısaltılmış).
const SQL_CUSTOMERS = 'WITH pgrst_source AS (SELECT "public"."customers".* FROM "public"."customers") SELECT * FROM pgrst_source'
const SQL_ORDERS = 'SELECT "public"."orders".* FROM "public"."orders" LIMIT $1'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'cnr-rec-'))
}

function writeSnapshot(dir, name, { ts, entries, role = 'conarium_c2', source = 'pg_stat_statements', v = 'conarium-dbsnapshot/0.1' }) {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify({ v, ts, role, source, entries }) + '\n')
  return path
}

function receipt({ ts = IN_WINDOW, tool = 'query', target = 'zion-rest', objects = [], seq = 1 }) {
  return {
    v: 'conarium-receipt/0.3',
    ts,
    request: { tool, target, argsHash: 'sha256:00' },
    dataRefs: objects.map((o) => ({ source: 'zion-rest', object: o, fieldsRequested: [] })),
    policy: { decision: 'allow' },
    chain: { seq },
  }
}

function writeReceipts(dir, name, receipts) {
  const path = join(dir, name)
  writeFileSync(path, receipts.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return path
}

function run(args) {
  // spawnSync (execFileSync değil): başarı yolunda da stderr lazım —
  // imza feragatnamesi exit 0'da dahi stderr'e yazılıyor.
  const r = spawnSync(process.execPath, [RECONCILE, ...args], { encoding: 'utf-8' })
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function setup({ beforeEntries, afterEntries, receipts, beforeTs = T0, afterTs = T1 }) {
  const dir = tmpDir()
  const before = writeSnapshot(dir, 'before.json', { ts: beforeTs, entries: beforeEntries })
  const after = writeSnapshot(dir, 'after.json', { ts: afterTs, entries: afterEntries })
  const rec = writeReceipts(dir, 'receipts.jsonl', receipts)
  return { dir, args: ['--before', before, '--after', after, '--receipts', rec] }
}

// ─── unit: tablo çıkarımı ────────────────────────────────────────────────────

describe('extractTables', () => {
  it('reads quoted schema.table, unquoted, and joins', () => {
    expect(extractTables('SELECT * FROM "public"."customers"')).toEqual([
      { schema: 'public', table: 'customers' },
    ])
    expect(extractTables('select a from orders o join public.items i on i.id = o.id')).toEqual([
      { schema: null, table: 'orders' },
      { schema: 'public', table: 'items' },
    ])
  })
  it('returns empty for pattern with no relation', () => {
    expect(extractTables('SELECT $1::text')).toEqual([])
  })
})

describe('classifyPattern', () => {
  it('marks SET / catalog queries as infrastructure', () => {
    expect(classifyPattern('SET search_path TO public').kind).toBe('infrastructure')
    expect(classifyPattern('SELECT * FROM pg_catalog.pg_class').kind).toBe('infrastructure')
    expect(classifyPattern('select set_config($1, $2, true)').kind).toBe('infrastructure')
  })
  it('marks unextractable data queries as unattributed', () => {
    expect(classifyPattern('SELECT $1 + $2').kind).toBe('unattributed')
  })
  it('marks user-table queries as data', () => {
    const c = classifyPattern(SQL_CUSTOMERS)
    expect(c.kind).toBe('data')
    expect(c.tables).toEqual([{ schema: 'public', table: 'customers' }])
  })
})

// ─── CLI: temiz mutabakat ────────────────────────────────────────────────────

describe('conarium-reconcile CLI', () => {
  it('exit 0 when every DB pattern is attributable to a receipt (pattern-level, not 1:1)', () => {
    // +5 çağrı tek desen; pencerede o tabloyu adlandıran TEK makbuz var.
    // Çağrı sayısı ≠ makbuz sayısı BİLEREK: PostgREST çarpanı hüküm değiştirmemeli.
    // Bu vaka aynı zamanda SINIRIN kanıtı: tek makbuz, penceredeki ek ifadeleri
    // temizliyor. Çıktı bu yüzden "covered" demez, kapsamı ayrıca yazar.
    const { args } = setup({
      beforeEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }],
      afterEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 15 }],
      receipts: [receipt({ objects: ['zion.customers'] })],
    })
    const r = run(args)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(
      'ok: every DB query pattern in the window is attributable to receipt(s) for the same table',
    )
    expect(r.stdout).toContain('never per call count')
    // Sınır beyanı çıktıda GÖRÜNMEK zorunda — sadece LIMITATIONS'ta durması yetmez.
    expect(r.stdout).toContain('not per-statement coverage')
    expect(r.stdout).not.toContain('is covered by receipts')
    expect(r.stdout).not.toContain('UNOBSERVED')
    expect(r.stderr).not.toContain('UNOBSERVED')
  })

  it('normalizes receipt object prefixes: "zion.customers" covers "public"."customers"', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 1 }],
      receipts: [receipt({ objects: ['zion.customers'] })],
    })
    expect(run(args).code).toBe(0)
  })

  it('describe_table target counts as coverage', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 1 }],
      receipts: [receipt({ tool: 'describe_table', target: 'customers', objects: [] })],
    })
    expect(run(args).code).toBe(0)
  })

  it('infrastructure-only activity is reported, not failed', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [{ queryid: '9', query: 'SET search_path TO public', calls: 3 }],
      receipts: [],
    })
    const r = run(args)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('infrastructure pattern(s)')
  })

  // ─── bypass yakalama — aracın var olma sebebi ─────────────────────────────

  it('exit 40 when the DB recorded a pattern with no covering receipt (bypass suspect)', () => {
    const { args } = setup({
      beforeEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }],
      afterEntries: [
        { queryid: '1', query: SQL_CUSTOMERS, calls: 11 },
        { queryid: '2', query: SQL_ORDERS, calls: 2 }, // makbuzu yok → yakalanmalı
      ],
      receipts: [receipt({ objects: ['zion.customers'] })],
    })
    const r = run(args)
    expect(r.code).toBe(40)
    expect(r.stderr).toContain('UNRECONCILED: 1 pattern(s)')
    expect(r.stderr).toContain('public.orders')
    // Dürüstlük cümlesi: niyet iddiası YOK, iki olası açıklama VAR.
    expect(r.stderr).toContain('NOT RECEIPTED')
    expect(r.stderr).toContain('bypassed, or the receipt sink failed')
    expect(r.stderr).toContain('does not by itself prove intent')
  })

  it('a receipt OUTSIDE the window does not cover the pattern', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [{ queryid: '1', query: SQL_ORDERS, calls: 1 }],
      receipts: [receipt({ ts: BEFORE_WINDOW, objects: ['zion.orders'] })],
    })
    const r = run(args)
    expect(r.code).toBe(40)
    expect(r.stdout).toContain('out of window: 1')
  })

  it('exit 40 with UNATTRIBUTED when a data pattern has no extractable table (not silently cleared)', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [{ queryid: '1', query: 'SELECT $1 + $2', calls: 1 }],
      receipts: [receipt({ objects: ['zion.customers'] })],
    })
    const r = run(args)
    expect(r.code).toBe(40)
    expect(r.stderr).toContain('UNATTRIBUTED: 1 pattern(s)')
  })

  it('unassigned receipts in window trigger the NOT definitive warning', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [{ queryid: '1', query: SQL_ORDERS, calls: 1 }],
      // query makbuzu ama dataRefs boş → nesneye atfedilemiyor
      receipts: [receipt({ objects: [] })],
    })
    const r = run(args)
    expect(r.code).toBe(40)
    expect(r.stderr).toContain('NOT definitive')
  })

  // ─── pencere güvenilirliği — fail-closed ──────────────────────────────────

  it('exit 20 on counter regression (stats reset mid-window)', () => {
    const { args } = setup({
      beforeEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }],
      afterEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 3 }],
      receipts: [],
    })
    const r = run(args)
    expect(r.code).toBe(20)
    expect(r.stderr).toContain('counter regression')
  })

  it('exit 20 when a queryid disappears from after (reset/eviction)', () => {
    const { args } = setup({
      beforeEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }],
      afterEntries: [],
      receipts: [],
    })
    const r = run(args)
    expect(r.code).toBe(20)
    expect(r.stderr).toContain('missing in after')
  })

  it('exit 20 on role mismatch between snapshots', () => {
    const dir = tmpDir()
    const before = writeSnapshot(dir, 'b.json', { ts: T0, entries: [], role: 'conarium_c2' })
    const after = writeSnapshot(dir, 'a.json', { ts: T1, entries: [], role: 'conarium_c3' })
    const rec = writeReceipts(dir, 'r.jsonl', [])
    const r = run(['--before', before, '--after', after, '--receipts', rec])
    expect(r.code).toBe(20)
    expect(r.stderr).toContain('role mismatch')
  })

  it('exit 20 on inverted window', () => {
    const { args } = setup({ beforeEntries: [], afterEntries: [], receipts: [], beforeTs: T1, afterTs: T0 })
    const r = run(args)
    expect(r.code).toBe(20)
    expect(r.stderr).toContain('empty or inverted')
  })

  it('exit 20 on missing flags and unknown snapshot version', () => {
    expect(run([]).code).toBe(20)
    const dir = tmpDir()
    const before = writeSnapshot(dir, 'b.json', { ts: T0, entries: [], v: 'conarium-dbsnapshot/9.9' })
    const after = writeSnapshot(dir, 'a.json', { ts: T1, entries: [] })
    const rec = writeReceipts(dir, 'r.jsonl', [])
    const r = run(['--before', before, '--after', after, '--receipts', rec])
    expect(r.code).toBe(20)
    expect(r.stderr).toContain('unsupported version')
  })

  it('--json emits a machine-readable verdict', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [{ queryid: '2', query: SQL_ORDERS, calls: 2 }],
      receipts: [],
    })
    const r = run([...args, '--json'])
    expect(r.code).toBe(40)
    const payload = JSON.parse(r.stdout.trim().split('\n').pop())
    expect(payload.ok).toBe(false)
    expect(payload.code).toBe(40)
    expect(payload.unreconciled).toHaveLength(1)
    expect(payload.unreconciled[0].uncoveredTables).toEqual(['public.orders'])
  })

  it('signature disclaimer is always printed (verify is a separate step)', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [],
      receipts: [],
    })
    const r = run(args)
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('signatures are NOT checked here')
    expect(r.stdout).not.toContain('UNOBSERVED')
    expect(r.stderr).not.toContain('UNOBSERVED')
  })
})

describe('unobserved — receipt named an object the counters did not increment', () => {
  function snap(ts, entries) {
    return {
      v: 'conarium-dbsnapshot/0.1',
      ts,
      role: 'conarium_c2',
      source: 'pg_stat_statements',
      entries: new Map(entries.map((e) => [e.queryid, e])),
    }
  }

  it('lists the receipt and keeps exit 0 when the DB recorded no increase', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [],
      receipts: [receipt({ objects: ['zion.customers'] })],
    })
    const r = run(args)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('UNOBSERVED: 1 receipt(s)')
    expect(r.stdout).toContain('zion.customers')
    expect(r.stdout).toContain('query')
  })

  it('is not unassigned: empty dataRefs stay in unassigned, not in unobserved', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [],
      receipts: [receipt({ objects: [] })],
    })
    const r = run(args)
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('NOT definitive')
    expect(r.stdout).not.toContain('UNOBSERVED')
    expect(r.stderr).not.toContain('UNOBSERVED')
  })

  it('reconcile() keeps unobserved off the verdict fields', () => {
    const result = reconcile(
      snap(T0, []),
      snap(T1, []),
      [receipt({ objects: ['zion.customers'] })],
    )
    expect(result.unobserved).toHaveLength(1)
    expect(result.unobserved[0].objects).toEqual(['zion.customers'])
    expect(result.unreconciled).toHaveLength(0)
    expect(result.receipts.unassigned).toBe(0)
  })

  it('a covering counter increment removes the receipt from unobserved', () => {
    const result = reconcile(
      snap(T0, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }]),
      snap(T1, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 15 }]),
      [receipt({ objects: ['zion.customers'] })],
    )
    expect(result.unobserved).toHaveLength(0)
    expect(result.reconciled).toHaveLength(1)
  })
})

