import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Governance, PolicyError } from '../governance.js'

type Dialect = 'postgres' | 'mssql' | 'oracle'

interface Vector {
  id: string
  class: string
  expect: 'deny' | 'cap' | 'mask'
  sql: Partial<Record<Dialect, string>>
  row?: Record<string, string>
  rawField?: string
}

interface Bundle {
  policy: {
    allowTables: string[]
    denyTables: string[]
    maskColumns: string[]
    maxRows: number
  }
  secret: string
  vectors: Vector[]
}

const bundle: Bundle = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../test-vectors/sql-gate/vectors.json'),
    'utf8',
  ),
)

function runDialect(dialect: Dialect) {
  const gov = new Governance(bundle.policy)
  const cases = bundle.vectors.filter(v => typeof v.sql[dialect] === 'string')

  describe(`sql-gate vectors · ${dialect} (${cases.length})`, () => {
    for (const v of cases) {
      it(`${v.class}/${v.id}`, () => {
        const sql = v.sql[dialect] as string
        if (v.expect === 'deny') {
          expect(() => gov.guardQuery(sql)).toThrow(PolicyError)
          return
        }

        let guarded
        try {
          guarded = gov.guardQuery(sql)
        } catch (err) {
          throw new Error(`${v.id}: expected ${v.expect}, gate denied: ${(err as Error).message}`)
        }

        if (v.expect === 'cap') {
          expect(guarded.sql, v.id).toMatch(/limit\s+\(?50\)?/i)
          expect(guarded.metadata.appliedRowCap).toBe(bundle.policy.maxRows)
          return
        }

        if (v.expect === 'mask') {
          const field = v.rawField as string
          const row = { ...(v.row ?? {}) }
          const out = gov.redact(
            { rows: [row], rowCount: 1, fields: Object.keys(row) },
            guarded.aliases,
            guarded.metadata,
          )
          const value = String(out.rows[0][field] ?? '')
          expect(value, `${v.id} still contains raw secret`).not.toContain(bundle.secret)
          expect(value.includes('[MASKED_PII]') || out.governance.maskedCount > 0, v.id).toBe(true)
        }
      })
    }
  })
}

runDialect('postgres')
