import { createRequire } from 'node:module'
import { PolicyError, type GovernanceMetadata } from '../governance.js'
import type { GovernancePolicy } from '../types.js'
import {
  findWriteToken,
  isSelectOrWith,
  normalizedSqlHead,
} from './rules.js'
import type { DialectAdapter, DialectQuestions } from './types.js'

const require = createRequire(import.meta.url)
const { Parser } = require('node-sql-parser/build/transactsql') as {
  Parser: new () => {
    parse(sql: string): { ast: unknown; tableList: string[] }
    sqlify(ast: unknown): string
  }
}

const PRE_DENY = [
  { re: /\bGO\b/i, reason: 'GO batch separator is not permitted.' },
  { re: /\bEXEC(?:UTE)?\b/i, reason: 'EXEC/EXECUTE is not permitted.' },
  { re: /\bxp_/i, reason: 'xp_* procedures are not permitted.' },
  { re: /\bsp_/i, reason: 'sp_* procedures are not permitted.' },
  { re: /\bOPENROWSET\b/i, reason: 'OPENROWSET is not permitted.' },
  { re: /\bOPENQUERY\b/i, reason: 'OPENQUERY is not permitted.' },
  { re: /\bOPENDATASOURCE\b/i, reason: 'OPENDATASOURCE is not permitted.' },
  { re: /\bFOR\s+XML\b/i, reason: 'FOR XML is not permitted.' },
  { re: /\bFOR\s+JSON\b/i, reason: 'FOR JSON is not permitted.' },
  { re: /\bSET\s+ROWCOUNT\b/i, reason: 'SET ROWCOUNT is not permitted.' },
] as const

export interface MssqlGuarded {
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

function asList(ast: unknown): Record<string, unknown>[] {
  if (Array.isArray(ast)) return ast as Record<string, unknown>[]
  if (ast && typeof ast === 'object') return [ast as Record<string, unknown>]
  return []
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

function collectCteNames(node: Record<string, unknown>): Set<string> {
  const names = new Set<string>()
  const withClause = node.with
  if (!Array.isArray(withClause)) return names
  for (const item of withClause) {
    const name = (item as { name?: { value?: string } | string })?.name
    if (typeof name === 'string') names.add(name.toLowerCase())
    else if (name && typeof name.value === 'string') names.add(name.value.toLowerCase())
  }
  return names
}

function walk(node: unknown, visit: (rec: Record<string, unknown>) => void): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  const rec = node as Record<string, unknown>
  visit(rec)
  for (const value of Object.values(rec)) walk(value, visit)
}

function collectTables(root: Record<string, unknown>, ctes: Set<string>): Set<string> {
  const tables = new Set<string>()
  walk(root, rec => {
    if (rec.type === 'function') {
      const raw = JSON.stringify(rec.name ?? '').toLowerCase()
      if (raw.includes('openrowset') || raw.includes('openquery') || raw.includes('opendatasource')) {
        deny('OPENROWSET / OPENQUERY / OPENDATASOURCE is not permitted.')
      }
    }
    if (typeof rec.table !== 'string') return
    if (rec.server) {
      deny(`Linked / multi-part name is not permitted.`)
    }
    const schemaFromSchema = typeof rec.schema === 'string' ? rec.schema : ''
    const schemaFromDb = typeof rec.db === 'string' ? rec.db : ''
    if (schemaFromSchema && schemaFromDb && schemaFromSchema.toLowerCase() !== schemaFromDb.toLowerCase()) {
      deny(`Three-part name '${schemaFromDb}.${schemaFromSchema}.${rec.table}' is not permitted.`)
    }
    const schema = schemaFromSchema || schemaFromDb
    if (!schema) {
      if (!ctes.has(rec.table.toLowerCase())) {
        deny(`Unqualified table '${rec.table}' is not permitted; use schema.table.`)
      }
      return
    }
    if (schema.includes('.')) {
      deny(`Linked / multi-part name '${schema}.${rec.table}' is not permitted.`)
    }
    tables.add(`${schema.toLowerCase()}.${rec.table.toLowerCase()}`)
  })
  return tables
}

function collectColumnRefs(node: unknown, into: string[]): void {
  walk(node, rec => {
    if (rec.type === 'column_ref' && typeof rec.column === 'string' && rec.column !== '*') {
      into.push(rec.column.toLowerCase())
    }
  })
}

function maskLeaf(pattern: string): string {
  return pattern.slice(pattern.lastIndexOf('.') + 1).toLowerCase()
}

function applyTop(ast: Record<string, unknown>, cap: number): void {
  const top = ast.top as { value?: number; percent?: string | null } | null
  if (top?.percent) deny('TOP n PERCENT is not a row cap and is not permitted.')
  if (top && typeof top.value === 'number' && top.value <= cap) return
  ast.top = { value: cap, percent: null }
}

function wrapUnion(ast: Record<string, unknown>, cap: number): Record<string, unknown> {
  return {
    type: 'select',
    with: null,
    options: null,
    distinct: null,
    columns: [{ expr: { type: 'column_ref', table: null, column: '*' }, as: null }],
    into: { position: null },
    from: [{
      expr: {
        tableList: [],
        columnList: [],
        ast,
        parentheses: true,
      },
      as: '_conarium_cap',
      operator: null,
    }],
    for: null,
    where: null,
    groupby: null,
    having: null,
    top: { value: cap, percent: null },
    orderby: null,
    limit: null,
  }
}

function applyRowCap(ast: Record<string, unknown>, cap: number): Record<string, unknown> {
  if (ast._next) return wrapUnion(ast, cap)
  applyTop(ast, cap)
  return ast
}

function policyAllows(policy: GovernancePolicy, qualified: string): boolean {
  const allow = policy.allowTables ?? []
  const denyList = policy.denyTables ?? []
  if (denyList.some(p => matchGlob(p, qualified))) return false
  if (allow.length === 0) return false
  return allow.some(p => matchGlob(p, qualified))
}

export function guardMssqlQuery(sql: string, policy: GovernancePolicy): MssqlGuarded {
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

  let parsed: { ast: unknown; tableList: string[] }
  try {
    parsed = new Parser().parse(sql)
  } catch (err) {
    deny(`Failed to parse SQL: ${(err as Error).message}`)
  }

  const stmts = asList(parsed.ast)
  if (stmts.length === 0) deny('Failed to parse SQL: empty AST')
  if (stmts.length > 1) deny('Multiple statements are not permitted.')

  const stmt = stmts[0]
  if (stmt.type !== 'select' && stmt.type !== 'with') {
    deny('Only read-only SELECT/WITH queries are permitted.')
  }

  const into = stmt.into as { type?: string } | null
  if (into?.type === 'into') deny('SELECT INTO is not permitted.')
  if (stmt.for) deny('FOR XML/JSON and other SELECT FOR clauses are not permitted.')

  const ctes = collectCteNames(stmt)
  const tables = collectTables(stmt, ctes)

  for (const qualified of tables) {
    if (qualified.startsWith('sys.') || qualified.startsWith('information_schema.')) {
      deny(`Access to system catalog '${qualified}' is forbidden.`, [...tables])
    }
    if (!policyAllows(policy, qualified)) {
      deny(`Access to table '${qualified}' is not permitted by policy.`, [...tables])
    }
  }

  const aliases: Record<string, string> = {}
  const maskedFields: string[] = []
  const masks = policy.maskColumns ?? []
  const columns = Array.isArray(stmt.columns) ? stmt.columns : []
  columns.forEach((col, index) => {
    const rec = col as { as?: string; expr?: unknown }
    const refs: string[] = []
    collectColumnRefs(rec.expr, refs)
    const outName = (rec.as || (refs.length === 1 ? refs[0] : `col_${index}`)).toLowerCase()
    const maskedRef = refs.find(r => masks.some(m => maskLeaf(m) === r || matchGlob(m, r)))
    if (maskedRef) {
      aliases[outName] = maskedRef
      maskedFields.push(rec.as || refs[0] || outName)
    } else if (rec.as && refs.length === 1) {
      aliases[rec.as.toLowerCase()] = refs[0]
    }
  })

  const rewrittenAst = applyRowCap(stmt, cap)
  let rewritten: string
  try {
    rewritten = new Parser().sqlify(rewrittenAst)
  } catch (err) {
    deny(`Failed to emit SQL: ${(err as Error).message}`, [...tables])
  }

  return {
    sql: rewritten,
    aliases,
    metadata: meta({
      accessedTables: [...tables],
      appliedRowCap: cap,
      maskedFields,
    }),
  }
}

export const mssqlAdapter: DialectAdapter = {
  dialect: 'mssql',
  inspect(sql: string): DialectQuestions {
    try {
      const out = guardMssqlQuery(sql, { allowTables: ['*'], maxRows: 50 })
      return {
        statementCount: 1,
        tables: out.metadata.accessedTables,
        columns: Object.keys(out.aliases),
        writes: false,
        functions: [],
        hasRowLimitNode: /top\s+\d+/i.test(out.sql),
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
