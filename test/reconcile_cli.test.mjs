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
const { extractTables, classifyPattern, reconcile, projectResultV2, loadMappingProfile } = await import(RECONCILE)

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

  // This test asserted exit 40 until 2026-08-17, which is the defect Walter
  // Hawkins described on the SCITT list: the window is decided by two clocks,
  // and an exact comparison across them lets skew produce the accusation. An
  // out-of-window receipt still does not COVER the pattern — the pattern is not
  // reconciled and the run still fails — but it is no longer reported as access
  // the gateway never receipted. 41, not 40, and no bypass sentence.
  it('a receipt OUTSIDE the window does not cover the pattern, and is not called a bypass', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [{ queryid: '1', query: SQL_ORDERS, calls: 1 }],
      receipts: [receipt({ ts: BEFORE_WINDOW, objects: ['zion.orders'] })],
    })
    const r = run(args)
    expect(r.code).toBe(41)
    expect(r.stdout).toContain('out of window: 1')
    expect(r.stderr).toContain('INDETERMINATE')
    expect(r.stderr).toContain('3600000ms outside')
    expect(r.stderr).not.toContain('bypassed, or the receipt sink failed')
  })

  it('a declared --skew smaller than the offset keeps it an unreconciled finding', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [{ queryid: '1', query: SQL_ORDERS, calls: 1 }],
      receipts: [receipt({ ts: BEFORE_WINDOW, objects: ['zion.orders'] })],
    })
    const r = run([...args, '--skew', '5s'])
    expect(r.code).toBe(40)
    expect(r.stderr).toContain('UNRECONCILED')
    expect(r.stderr).toContain('bypassed, or the receipt sink failed')
  })

  it('--skew rejects a duration it cannot read rather than defaulting', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [],
      receipts: [],
    })
    const r = run([...args, '--skew', 'soonish'])
    expect(r.code).toBe(20)
    expect(r.stderr).toContain('cannot read "soonish" as a duration')
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


describe('clock skew — a receipt just outside the window must not manufacture an accusation', () => {
  function snap(ts, entries) {
    return {
      v: 'conarium-dbsnapshot/0.1',
      ts,
      role: 'conarium_c2',
      source: 'pg_stat_statements',
      entries: new Map(entries.map((e) => [e.queryid, e])),
    }
  }

  // The window comes from the database's snapshot timestamps; the receipt
  // timestamp comes from the gateway. Two clocks. A gateway trailing the
  // database turns a receipt that genuinely covers the table into an
  // out-of-window receipt, and the table it would have covered into an
  // accusation of bypass.
  const JUST_BEFORE = '2026-08-06T09:59:57.000Z' // 3s before T0
  const LONG_BEFORE = '2026-08-06T04:00:00.000Z' // 6h before T0

  it('a covering receipt 3s outside the window is indeterminate, not unreconciled', () => {
    const result = reconcile(
      snap(T0, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }]),
      snap(T1, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 15 }]),
      [receipt({ ts: JUST_BEFORE, objects: ['zion.customers'] })],
    )
    expect(result.unreconciled).toHaveLength(0)
    expect(result.indeterminate).toHaveLength(1)
    expect(result.indeterminate[0].requiredSkewMs).toBe(3000)
  })

  it('a covering receipt 6h outside the window stays unreconciled — that is not skew', () => {
    const result = reconcile(
      snap(T0, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }]),
      snap(T1, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 15 }]),
      [receipt({ ts: LONG_BEFORE, objects: ['zion.customers'] })],
      { skewMs: 60_000 },
    )
    expect(result.indeterminate).toHaveLength(0)
    expect(result.unreconciled).toHaveLength(1)
  })

  it('a pattern no receipt covers at all is untouched by the skew path', () => {
    const result = reconcile(
      snap(T0, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }]),
      snap(T1, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 15 }]),
      [receipt({ ts: JUST_BEFORE, objects: ['zion.orders'] })],
    )
    expect(result.indeterminate).toHaveLength(0)
    expect(result.unreconciled).toHaveLength(1)
  })
})

// Cursor attacked the indeterminate class on 2026-08-17 and got through: a
// legitimate receipt from the previous day, naming the same table, turned a
// real in-window bypass from 40 into 41 — and the run then said the access was
// "NOT reported as unreceipted access". 41 was never a silent pass (CI stays
// red), but that sentence is an exculpation twenty-three hours of offset cannot
// support. The class stays; the exculpation is now bounded by the window's own
// length, which is derived from the input rather than chosen.
describe('an offset larger than the window is not a boundary artefact', () => {
  function snap(ts, entries) {
    return {
      v: 'conarium-dbsnapshot/0.1',
      ts,
      role: 'conarium_c2',
      source: 'pg_stat_statements',
      entries: new Map(entries.map((e) => [e.queryid, e])),
    }
  }
  const YESTERDAY = '2026-08-05T11:00:00.000Z' // 23h before T0; window is 2h

  it('a receipt from the previous day is indeterminate but NOT boundary-plausible', () => {
    const result = reconcile(
      snap(T0, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }]),
      snap(T1, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 15 }]),
      [receipt({ ts: YESTERDAY, objects: ['zion.customers'] })],
    )
    expect(result.indeterminate).toHaveLength(1)
    expect(result.indeterminate[0].boundaryPlausible).toBe(false)
    expect(result.clocks.windowMs).toBe(7_200_000)
  })

  it('a receipt inside the window length keeps the boundary reading', () => {
    const result = reconcile(
      snap(T0, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }]),
      snap(T1, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 15 }]),
      [receipt({ ts: '2026-08-06T09:59:57.000Z', objects: ['zion.customers'] })],
    )
    expect(result.indeterminate[0].boundaryPlausible).toBe(true)
  })

  // The edge Cursor named: a five-second window and a six-second NTP step. The
  // window rule alone would refuse the boundary reading, and it would be wrong.
  // A declared --skew is the operator's own statement about their clocks and
  // outranks a threshold inferred from the window.
  it('a declared --skew outranks the window length on a short window', () => {
    const shortFrom = '2026-08-06T10:00:00.000Z'
    const shortTo = '2026-08-06T10:00:05.000Z' // 5s window
    const ntpStep = '2026-08-06T09:59:54.000Z' // 6s before the start
    const args = [
      snap(shortFrom, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }]),
      snap(shortTo, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 15 }]),
      [receipt({ ts: ntpStep, objects: ['zion.customers'] })],
    ]
    expect(reconcile(...args).indeterminate[0].boundaryPlausible).toBe(false)
    expect(reconcile(...args, { skewMs: 10_000 }).indeterminate[0].boundaryPlausible).toBe(true)
  })

  it('the CLI refuses to excuse a beyond-window offset', () => {
    const { args } = setup({
      beforeEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }],
      afterEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 15 }],
      receipts: [receipt({ ts: YESTERDAY, objects: ['zion.customers'] })],
    })
    const r = run(args)
    expect(r.code).toBe(41)
    expect(r.stderr).toContain('INDETERMINATE (not the boundary)')
    expect(r.stderr).toContain('NOT excused as a timing effect')
    expect(r.stderr).not.toContain('NOT reported as unreceipted access')
  })
})

describe('coverage-reconciliation/2 projection', () => {
  function snap(ts, entries) {
    return {
      v: 'conarium-dbsnapshot/0.1',
      ts,
      role: 'conarium_c2',
      source: 'pg_stat_statements',
      entries: new Map(entries.map((e) => [e.queryid, e])),
    }
  }

  const ctx = {
    snapshotStartRaw: Buffer.from('before'),
    snapshotEndRaw: Buffer.from('after'),
    receiptsRaw: Buffer.from('receipts'),
    profileRaw: Buffer.from('profile'),
  }

  it('does not change /1 exit codes: five calls, one receipt still exits 0', () => {
    const { args } = setup({
      beforeEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }],
      afterEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 15 }],
      receipts: [receipt({ objects: ['zion.customers'] })],
    })
    expect(run(args).code).toBe(0)
    const withV2 = run([...args, '--json-v2'])
    expect(withV2.code).toBe(0)
    const v2 = JSON.parse(withV2.stdout)
    expect(v2.v).toBe('coverage-reconciliation/2')
    expect(v2.profile).toBeNull()
    expect(v2.bounds.multiplicity).toBe('undeclared')
    expect(v2.counts.matched).toBe(0)
    expect(v2.items.every((i) => i.outcome === 'indeterminate')).toBe(true)
    expect(v2.outcome).toBe('exceptions')
  })

  it('refuses to mix /1 and /2 in one body', () => {
    const { args } = setup({
      beforeEntries: [],
      afterEntries: [],
      receipts: [],
    })
    const r = run([...args, '--json', '--json-v2'])
    expect(r.code).toBe(20)
    expect(r.stderr).toContain('MUST NOT read a /1 result as a /2 result')
  })

  it('profile null: unattributed is indeterminate, not observed-without-receipt', () => {
    const result = reconcile(
      snap(T0, []),
      snap(T1, [{ queryid: '1', query: 'SELECT $1 + $2', calls: 3 }]),
      [],
    )
    expect(result.unattributed).toHaveLength(1)
    const v2 = projectResultV2(result, ctx)
    expect(v2.items.some((i) => i.reason === 'unattributed' && i.outcome === 'indeterminate')).toBe(true)
    expect(v2.counts['observed-without-receipt']).toBe(0)
    expect(v2.outcome).toBe('exceptions')
  })

  it('unobserved becomes receipted-without-observation and forces exceptions', () => {
    const result = reconcile(snap(T0, []), snap(T1, []), [receipt({ objects: ['zion.customers'] })])
    expect(result.unobserved).toHaveLength(1)
    const v2 = projectResultV2(result, ctx)
    expect(v2.counts['receipted-without-observation']).toBe(1)
    expect(v2.outcome).toBe('exceptions')
  })

  it('profile null: infrastructure is indeterminate, not excluded', () => {
    const result = reconcile(
      snap(T0, []),
      snap(T1, [{ queryid: '1', query: 'SET search_path TO public', calls: 1 }]),
      [],
    )
    const v2 = projectResultV2(result, ctx)
    expect(v2.profile).toBeNull()
    expect(v2.counts.excluded).toBe(0)
    expect(v2.counts.indeterminate).toBe(1)
    expect(v2.items[0].outcome).toBe('indeterminate')
    expect(v2.items[0].reason).toBe('exclusion-undeclared')
    expect(v2.items[0].rule).toBeUndefined()
    expect(v2.bounds.exclusion).toBe('undeclared')
    expect(v2.outcome).toBe('exceptions')
  })

  it('a declared exclusion rule can produce excluded / no-exceptions', () => {
    const result = reconcile(
      snap(T0, []),
      snap(T1, [{ queryid: '1', query: 'SET search_path TO public', calls: 1 }]),
      [],
    )
    const v2 = projectResultV2(result, {
      ...ctx,
      profile: {
        version: '1',
        maxStatementsPerReceipt: null,
        exclusions: [{ id: 'infra-query', version: '1' }],
      },
    })
    expect(v2.counts.excluded).toBe(1)
    expect(v2.items[0].outcome).toBe('excluded')
    expect(v2.items[0].rule).toEqual({ id: 'infra-query', version: '1' })
    expect(v2.bounds.exclusion).toBe('operator-declared')
    expect(v2.outcome).toBe('no-exceptions')
  })

  it('profile with no exclusion rules leaves the exclusion bound undeclared', () => {
    const result = reconcile(
      snap(T0, []),
      snap(T1, [{ queryid: '1', query: 'SET search_path TO public', calls: 1 }]),
      [],
    )
    const v2 = projectResultV2(result, {
      ...ctx,
      profile: {
        version: '1',
        maxStatementsPerReceipt: 8,
        exclusions: [],
      },
    })
    expect(v2.bounds.exclusion).toBe('undeclared')
    expect(v2.bounds.multiplicity).toBe('operator-declared')
    expect(v2.items[0].outcome).toBe('indeterminate')
    expect(v2.items[0].reason).toBe('exclusion-not-in-profile')
    expect(v2.counts.excluded).toBe(0)
    expect(v2.outcome).toBe('exceptions')
  })

  it('a declared multiplicity bound can produce matched / no-exceptions', () => {
    const result = reconcile(
      snap(T0, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }]),
      snap(T1, [{ queryid: '1', query: SQL_CUSTOMERS, calls: 11 }]),
      [receipt({ objects: ['zion.customers'] })],
    )
    const v2 = projectResultV2(result, {
      ...ctx,
      profile: {
        version: '1',
        maxStatementsPerReceipt: 8,
        exclusions: [
          { id: 'infra-query', version: '1' },
          { id: 'infra-schema', version: '1' },
        ],
      },
    })
    expect(v2.counts.matched).toBe(1)
    expect(v2.counts.indeterminate).toBe(0)
    expect(v2.outcome).toBe('no-exceptions')
    expect(v2.profile.version).toBe('1')
    expect(v2.bounds.multiplicity).toBe('operator-declared')
  })

  it('--json /1 body still carries conarium-reconcile/0.1, never /2', () => {
    const { args } = setup({
      beforeEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 10 }],
      afterEntries: [{ queryid: '1', query: SQL_CUSTOMERS, calls: 15 }],
      receipts: [receipt({ objects: ['zion.customers'] })],
    })
    const r = run([...args, '--json'])
    expect(r.code).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.v).toBe('conarium-reconcile/0.1')
    expect(body.ok).toBe(true)
    expect(body.reconciled.length).toBe(1)
  })
})

