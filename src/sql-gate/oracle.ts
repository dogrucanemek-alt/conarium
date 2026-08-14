import { init, parse } from '@guanmingchiu/sqlparser-ts'
import { PolicyError, type GovernanceMetadata } from '../governance.js'
import type { GovernancePolicy } from '../types.js'
import {
  findWriteToken,
  isSelectOrWith,
  normalizedSqlHead,
} from './rules.js'
import type { DialectAdapter, DialectQuestions } from './types.js'

await init()

const PRE_DENY = [
  { re: /\bROWNUM\b/i, reason: 'ROWNUM is not a row cap and is not permitted.' },
  { re: /\bUTL_/i, reason: 'UTL_* packages are not permitted.' },
  { re: /\bDBMS_/i, reason: 'DBMS_* packages are not permitted.' },
  { re: /\bBEGIN\b/i, reason: 'Anonymous PL/SQL blocks are not permitted.' },
] as const

export interface OracleGuarded {
  sql: string
  aliases: Record<string, string>
  metadata: GovernanceMetadata
}

function meta(partial: Partial<GovernanceMetadata> = {}): GovernanceMetadata {
  return {
    accessedTables: [],
    accessedFunctions: [],
    appliedRowCap: 0,
    maskedFields: [],
    maskedCount: 0,
    denied: false,
    ...partial,
  }
}

function deny(reason: string, tables: string[] = []): never {
  throw new PolicyError(reason, meta({
    accessedTables: tables,
    denied: true,
    denyReason: reason,
  }))
}

function matchGlob(pattern: string, value: string): boolean {
  const p = pattern.trim().toLowerCase()
  const v = value.trim().toLowerCase()
  if (p === '*' || p === '*.*') return true
  if (p.endsWith('.*')) return v.startsWith(p.slice(0, -1))
  if (p.startsWith('*.')) return v.endsWith(p.slice(1))
  if (p.endsWith('*')) return v.startsWith(p.slice(0, -1))
  return p === v
}

function identValue(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined
  const rec = node as Record<string, unknown>
  if (rec.Identifier && typeof rec.Identifier === 'object') {
    const value = (rec.Identifier as { value?: string }).value
    return typeof value === 'string' ? value : undefined
  }
  if (typeof rec.value === 'string') return rec.value
  return undefined
}

function walk(node: unknown, visit: (rec: Record<string, unknown>) => void): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  const rec = node as Record<string, unknown>
  visit(rec)
  for (const [key, value] of Object.entries(rec)) {
    if (key === 'span' || key === 'token') continue
    walk(value, visit)
  }
}

function collectCteNames(root: unknown): Set<string> {
  const names = new Set<string>()
  walk(root, rec => {
    if (!rec.alias || typeof rec.alias !== 'object') return
    const alias = rec.alias as { name?: unknown }
    const value = identValue(alias.name) ?? identValue(alias)
    if (value && rec.query) names.add(value.toLowerCase())
  })
  return names
}

function collectTables(root: unknown, ctes: Set<string>): Set<string> {
  const tables = new Set<string>()
  walk(root, rec => {
    const table = rec.Table as { name?: unknown[] } | undefined
    if (!table || !Array.isArray(table.name)) return
    const parts = table.name.map(identValue).filter((p): p is string => !!p)
    if (parts.some(p => p.includes('@'))) {
      deny('Database link (@) is not permitted.')
    }
    if (parts.length >= 3) {
      deny(`Multi-part name '${parts.join('.')}' is not permitted.`)
    }
    if (parts.length === 0) return
    if (parts.length === 1) {
      if (!ctes.has(parts[0].toLowerCase())) {
        deny(`Unqualified table '${parts[0]}' is not permitted; use schema.table.`)
      }
      return
    }
    tables.add(`${parts[0].toLowerCase()}.${parts[1].toLowerCase()}`)
  })
  return tables
}

function collectAliases(root: unknown, masks: string[]): { aliases: Record<string, string>; maskedFields: string[] } {
  const aliases: Record<string, string> = {}
  const maskedFields: string[] = []
  const leaves = masks.map(m => m.slice(m.lastIndexOf('.') + 1).toLowerCase())

  walk(root, rec => {
    const aliased = rec.ExprWithAlias as { expr?: unknown; alias?: { value?: string } } | undefined
    if (!aliased) return
    const out = aliased.alias?.value?.toLowerCase()
    const refs: string[] = []
    walk(aliased.expr, inner => {
      const id = identValue(inner)
      if (id && inner.Identifier) refs.push(id.toLowerCase())
    })
    if (!out || refs.length === 0) return
    const masked = refs.find(r => leaves.includes(r))
    if (masked) {
      aliases[out] = masked
      maskedFields.push(out)
    } else if (refs.length === 1) {
      aliases[out] = refs[0]
    }
  })
  return { aliases, maskedFields }
}

function policyAllows(policy: GovernancePolicy, qualified: string): boolean {
  const allow = policy.allowTables ?? []
  const denyList = policy.denyTables ?? []
  if (denyList.some(p => matchGlob(p, qualified))) return false
  if (allow.length === 0) return false
  return allow.some(p => matchGlob(p, qualified))
}

function applyFetchCap(sql: string, cap: number): string {
  const core = sql.trim().replace(/;+\s*$/, '')
  return `SELECT * FROM (${core}) _conarium_cap FETCH FIRST ${cap} ROWS ONLY`
}

export function guardOracleQuery(sql: string, policy: GovernancePolicy): OracleGuarded {
  const cap = policy.maxRows ?? 100
  const norm = normalizedSqlHead(sql)

  for (const rule of PRE_DENY) {
    if (rule.re.test(sql)) deny(rule.reason)
  }

  if (!isSelectOrWith(norm)) {
    deny('Only read-only SELECT/WITH queries are permitted.')
  }

  const writeTok = findWriteToken(norm)
  if (writeTok) deny(`Blocked write operation: ${writeTok}`)

  let stmts: unknown[]
  try {
    stmts = parse(sql, 'oracle') as unknown[]
  } catch (err) {
    deny(`Failed to parse SQL: ${(err as Error).message}`)
  }

  if (!Array.isArray(stmts) || stmts.length === 0) deny('Failed to parse SQL: empty AST')
  if (stmts.length > 1) deny('Multiple statements are not permitted.')

  const stmt = stmts[0] as Record<string, unknown>
  if (!stmt.Query) deny('Only read-only SELECT/WITH queries are permitted.')

  const ctes = collectCteNames(stmt)
  const tables = collectTables(stmt, ctes)

  for (const qualified of tables) {
    if (qualified.startsWith('sys.') || qualified.startsWith('system.')) {
      deny(`Access to system catalog '${qualified}' is forbidden.`, [...tables])
    }
    if (!policyAllows(policy, qualified)) {
      deny(`Access to table '${qualified}' is not permitted by policy.`, [...tables])
    }
  }

  const { aliases, maskedFields } = collectAliases(stmt, policy.maskColumns ?? [])

  return {
    sql: applyFetchCap(sql, cap),
    aliases,
    metadata: meta({
      accessedTables: [...tables],
      appliedRowCap: cap,
      maskedFields,
    }),
  }
}

export const oracleAdapter: DialectAdapter = {
  dialect: 'oracle',
  inspect(sql: string): DialectQuestions {
    try {
      const out = guardOracleQuery(sql, { allowTables: ['*'], maxRows: 50 })
      return {
        statementCount: 1,
        tables: out.metadata.accessedTables,
        columns: Object.keys(out.aliases),
        writes: false,
        functions: [],
        hasRowLimitNode: /fetch\s+first\s+\d+/i.test(out.sql),
        parseFailed: false,
      }
    } catch (err) {
      return {
        statementCount: 0,
        tables: [],
        columns: [],
        writes: false,
        functions: [],
        hasRowLimitNode: false,
        parseFailed: true,
        parseError: (err as Error).message,
      }
    }
  },
}
