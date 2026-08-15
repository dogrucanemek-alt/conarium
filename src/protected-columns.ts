/**
 * Separate AST pass for `policy.protectedColumns`.
 *
 * Do not fold this into the lineage/mask walk in governance.ts — that walk
 * decides what to redact in the result set. This walk decides whether the
 * statement is allowed to ask the database about a protected value at all.
 */
import type {
  Expr,
  ExprRef,
  From,
  SelectFromStatement,
  SelectStatement,
  Statement,
} from 'pgsql-ast-parser'
import type { GovernancePolicy } from './types.js'
import { resolveSqlDialect } from './sql-gate/dispatch.js'

export type ProtectedPosition = 'WHERE' | 'HAVING' | 'JOIN' | 'ORDER BY' | 'GROUP BY' | 'SELECT'

export function protectedColumnDenyMessage(column: string, position: ProtectedPosition): string {
  return `protected column "${column}" may not appear in ${position}`
}

export function matchColumnGlob(pattern: string, value: string): boolean {
  const p = pattern.trim().toLowerCase()
  const v = value.trim().toLowerCase()
  if (p === '*' || p === '*.*') return true
  if (p.endsWith('.*')) return v.startsWith(p.slice(0, -1))
  if (p.startsWith('*.')) return v.endsWith(p.slice(1))
  if (p.endsWith('*')) return v.startsWith(p.slice(0, -1))
  return p === v
}

function lastSegment(pattern: string): string {
  return pattern.slice(pattern.lastIndexOf('.') + 1).toLowerCase()
}

function displayName(pattern: string, table: string | undefined, column: string): string {
  if (!pattern.startsWith('*.') && pattern.includes('.')) return pattern
  if (table) return `${table}.${column}`
  return column
}

function matchAgainst(patterns: string[], candidates: string[], column: string): string | null {
  const col = column.toLowerCase()
  for (const pattern of patterns) {
    if (candidates.some((c) => matchColumnGlob(pattern, c))) return pattern
    if (lastSegment(pattern) === col) return pattern
  }
  return null
}

function matchTableColumn(
  patterns: string[],
  schema: string | undefined,
  table: string | undefined,
  column: string,
): string | null {
  const candidates = [column]
  if (table) candidates.push(`${table}.${column}`)
  if (schema && table) candidates.push(`${schema}.${table}.${column}`)
  if (schema) candidates.push(`${schema}.${column}`)
  return matchAgainst(patterns, candidates, column)
}

/**
 * Boot-time: a non-empty `protectedColumns` is a promise. If this process
 * cannot walk the AST for predicate positions, refuse to start.
 */
export function assertProtectedColumnsSupported(policy?: GovernancePolicy): void {
  const cols = policy?.protectedColumns
  if (!cols || cols.length === 0) return
  const dialect = resolveSqlDialect(policy?.dialect)
  if (dialect === 'postgres') return
  throw new Error(
    `Conarium: policy.protectedColumns requires a dialect whose AST can be walked for predicate positions (postgres). dialect "${dialect}" cannot enforce protected columns.`,
  )
}

interface TableSource {
  kind: 'table'
  schema?: string
  table: string
}

interface DerivedSource {
  kind: 'derived'
  protectedOutputs: Map<string, string>
  star: boolean
}

type Source = TableSource | DerivedSource

interface Scope {
  sources: Map<string, Source>
}

type Classified =
  | { kind: 'none' }
  | { kind: 'star' }
  | { kind: 'unknown' }
  | { kind: 'protected'; name: string; derived: boolean; column: string }

function norm(value: string): string {
  return value.trim().toLowerCase()
}

export function enforceProtectedColumns(
  statement: Statement | SelectStatement,
  patterns: string[],
  deny: (reason: string) => never,
): void {
  walkRead(statement, patterns, deny, new Set(), new Map())
}

function walkRead(
  statement: Statement | SelectStatement,
  patterns: string[],
  deny: (reason: string) => never,
  cteNames: Set<string>,
  cteOutputs: Map<string, Map<string, string>>,
): Map<string, string> {
  if (statement.type === 'with') {
    const scopedNames = new Set(cteNames)
    const scopedOutputs = new Map(cteOutputs)
    for (const binding of statement.bind) {
      scopedNames.add(norm(binding.alias.name))
    }
    for (const binding of statement.bind) {
      const outputs = walkRead(binding.statement as Statement, patterns, deny, scopedNames, scopedOutputs)
      scopedOutputs.set(norm(binding.alias.name), outputs)
    }
    return walkRead(statement.in as Statement, patterns, deny, scopedNames, scopedOutputs)
  }

  if (statement.type === 'with recursive') {
    const scopedNames = new Set(cteNames)
    const scopedOutputs = new Map(cteOutputs)
    const cteName = norm(statement.alias.name)
    scopedNames.add(cteName)
    const outputs = walkRead(statement.bind, patterns, deny, scopedNames, scopedOutputs)
    scopedOutputs.set(cteName, outputs)
    return walkRead(statement.in as Statement, patterns, deny, scopedNames, scopedOutputs)
  }

  if (statement.type === 'select') {
    return walkSelect(statement, patterns, deny, cteNames, cteOutputs)
  }

  if (statement.type === 'union' || statement.type === 'union all') {
    const left = walkRead(statement.left, patterns, deny, cteNames, cteOutputs)
    const right = walkRead(statement.right, patterns, deny, cteNames, cteOutputs)
    return new Map([...left, ...right])
  }

  if (statement.type === 'values') {
    return new Map()
  }

  deny('protected column analysis cannot classify this statement')
}

function walkSelect(
  statement: SelectFromStatement,
  patterns: string[],
  deny: (reason: string) => never,
  cteNames: Set<string>,
  cteOutputs: Map<string, Map<string, string>>,
): Map<string, string> {
  const scope: Scope = { sources: new Map() }

  for (const from of statement.from ?? []) {
    collectFrom(from, patterns, deny, scope, cteNames, cteOutputs)
  }

  if (statement.where) assertNoProtected(statement.where, 'WHERE', patterns, deny, scope, cteNames, cteOutputs)
  if (statement.having) assertNoProtected(statement.having, 'HAVING', patterns, deny, scope, cteNames, cteOutputs)
  for (const expr of statement.groupBy ?? []) {
    assertNoProtected(expr, 'GROUP BY', patterns, deny, scope, cteNames, cteOutputs)
  }
  for (const order of statement.orderBy ?? []) {
    assertNoProtected(order.by, 'ORDER BY', patterns, deny, scope, cteNames, cteOutputs)
  }
  if (Array.isArray(statement.distinct)) {
    for (const expr of statement.distinct) {
      assertNoProtected(expr, 'GROUP BY', patterns, deny, scope, cteNames, cteOutputs)
    }
  }

  const outputs = new Map<string, string>()
  const columns = statement.columns ?? []
  for (const column of columns) {
    const classified = classifyExpr(column.expr, patterns, deny, scope, cteNames, cteOutputs)
    if (classified.kind === 'unknown') {
      deny('protected column analysis cannot classify this expression in SELECT')
    }
    if (classified.kind === 'protected' && classified.derived) {
      deny(protectedColumnDenyMessage(classified.name, 'SELECT'))
    }
    if (classified.kind === 'protected' && !classified.derived) {
      const outName = column.alias ? norm(column.alias.name) : classified.column
      outputs.set(outName, classified.name)
    }
    if (classified.kind === 'star') {
      for (const source of scope.sources.values()) {
        if (source.kind === 'derived') {
          for (const [k, v] of source.protectedOutputs) outputs.set(k, v)
        }
      }
    }
  }
  return outputs
}

function collectFrom(
  from: From,
  patterns: string[],
  deny: (reason: string) => never,
  scope: Scope,
  cteNames: Set<string>,
  cteOutputs: Map<string, Map<string, string>>,
): void {
  if (from.type === 'table') {
    const tableName = norm(from.name.name)
    const alias = from.name.alias ? norm(from.name.alias) : tableName
    if (!from.name.schema && cteNames.has(tableName)) {
      scope.sources.set(alias, {
        kind: 'derived',
        protectedOutputs: new Map(cteOutputs.get(tableName) ?? []),
        star: false,
      })
    } else {
      scope.sources.set(alias, {
        kind: 'table',
        schema: from.name.schema ? norm(from.name.schema) : undefined,
        table: tableName,
      })
    }
    collectJoin(from, patterns, deny, scope, cteNames, cteOutputs)
    return
  }

  if (from.type === 'statement') {
    const inner = walkRead(from.statement, patterns, deny, cteNames, cteOutputs)
    scope.sources.set(norm(from.alias), {
      kind: 'derived',
      protectedOutputs: inner,
      star: false,
    })
    collectJoin(from, patterns, deny, scope, cteNames, cteOutputs)
    return
  }

  if (from.type === 'call') {
    for (const arg of from.args) {
      assertNoProtected(arg, 'SELECT', patterns, deny, scope, cteNames, cteOutputs)
    }
    collectJoin(from, patterns, deny, scope, cteNames, cteOutputs)
    return
  }

  deny('protected column analysis cannot classify this FROM item')
}

function collectJoin(
  from: From,
  patterns: string[],
  deny: (reason: string) => never,
  scope: Scope,
  cteNames: Set<string>,
  cteOutputs: Map<string, Map<string, string>>,
): void {
  const join = from.join
  if (!join) return
  if (join.on) assertNoProtected(join.on, 'JOIN', patterns, deny, scope, cteNames, cteOutputs)
  for (const name of join.using ?? []) {
    const column = norm(name.name)
    const hit = classifyRef(
      { type: 'ref', name: column },
      patterns,
      scope,
    )
    if (hit.kind === 'protected') {
      deny(protectedColumnDenyMessage(hit.name, 'JOIN'))
    }
  }
}

function assertNoProtected(
  expr: Expr,
  position: ProtectedPosition,
  patterns: string[],
  deny: (reason: string) => never,
  scope: Scope,
  cteNames: Set<string>,
  cteOutputs: Map<string, Map<string, string>>,
): void {
  const classified = classifyExpr(expr, patterns, deny, scope, cteNames, cteOutputs)
  if (classified.kind === 'unknown') {
    deny(`protected column analysis cannot classify this expression in ${position}`)
  }
  if (classified.kind === 'protected') {
    deny(protectedColumnDenyMessage(classified.name, position))
  }
}

function classifyRef(ref: ExprRef, patterns: string[], scope: Scope): Classified {
  if (ref.name === '*') return { kind: 'star' }
  const column = norm(ref.name)

  if (ref.table?.schema) {
    const schema = norm(ref.table.schema)
    const table = norm(ref.table.name)
    const pattern = matchTableColumn(patterns, schema, table, column)
    if (pattern) return { kind: 'protected', name: displayName(pattern, table, column), derived: false, column }
    return { kind: 'none' }
  }

  if (ref.table?.name) {
    const alias = norm(ref.table.name)
    const source = scope.sources.get(alias)
    if (source?.kind === 'derived') {
      const mapped = source.protectedOutputs.get(column)
      if (mapped) return { kind: 'protected', name: mapped, derived: false, column }
      if (source.star) {
        const pattern = matchTableColumn(patterns, undefined, undefined, column)
        if (pattern) return { kind: 'protected', name: displayName(pattern, undefined, column), derived: false, column }
      }
      return { kind: 'none' }
    }
    if (source?.kind === 'table') {
      const pattern = matchTableColumn(patterns, source.schema, source.table, column)
      if (pattern) return { kind: 'protected', name: displayName(pattern, source.table, column), derived: false, column }
      return { kind: 'none' }
    }
    const pattern = matchTableColumn(patterns, undefined, alias, column)
    if (pattern) return { kind: 'protected', name: displayName(pattern, alias, column), derived: false, column }
    return { kind: 'none' }
  }

  for (const source of scope.sources.values()) {
    if (source.kind === 'derived') {
      const mapped = source.protectedOutputs.get(column)
      if (mapped) return { kind: 'protected', name: mapped, derived: false, column }
      if (source.star) {
        const pattern = matchTableColumn(patterns, undefined, undefined, column)
        if (pattern) return { kind: 'protected', name: displayName(pattern, undefined, column), derived: false, column }
      }
    }
    if (source.kind === 'table') {
      const pattern = matchTableColumn(patterns, source.schema, source.table, column)
      if (pattern) return { kind: 'protected', name: displayName(pattern, source.table, column), derived: false, column }
    }
  }

  const pattern = matchTableColumn(patterns, undefined, undefined, column)
  if (pattern) return { kind: 'protected', name: displayName(pattern, undefined, column), derived: false, column }
  return { kind: 'none' }
}

function classifyExpr(
  expr: Expr,
  patterns: string[],
  deny: (reason: string) => never,
  scope: Scope,
  cteNames: Set<string>,
  cteOutputs: Map<string, Map<string, string>>,
): Classified {
  switch (expr.type) {
    case 'ref':
      return classifyRef(expr, patterns, scope)
    case 'integer':
    case 'numeric':
    case 'string':
    case 'boolean':
    case 'null':
    case 'default':
    case 'parameter':
    case 'keyword':
    case 'constant':
      return { kind: 'none' }
    case 'cast': {
      const inner = classifyExpr(expr.operand, patterns, deny, scope, cteNames, cteOutputs)
      if (inner.kind === 'protected' && !inner.derived && expr.operand.type === 'ref') return inner
      return promoteDerived(inner)
    }
    case 'call': {
      const parts = [
        ...expr.args.map((arg) => classifyExpr(arg, patterns, deny, scope, cteNames, cteOutputs)),
        ...(expr.filter ? [classifyExpr(expr.filter, patterns, deny, scope, cteNames, cteOutputs)] : []),
        ...(expr.orderBy ?? []).map((order) => classifyExpr(order.by, patterns, deny, scope, cteNames, cteOutputs)),
        ...(expr.withinGroup ? [classifyExpr(expr.withinGroup.by, patterns, deny, scope, cteNames, cteOutputs)] : []),
        ...(expr.over?.orderBy ?? []).map((order) => classifyExpr(order.by, patterns, deny, scope, cteNames, cteOutputs)),
        ...(expr.over?.partitionBy ?? []).map((item) => classifyExpr(item, patterns, deny, scope, cteNames, cteOutputs)),
      ]
      return firstProtectedDerived(parts)
    }
    case 'binary':
      return firstProtectedDerived([
        classifyExpr(expr.left, patterns, deny, scope, cteNames, cteOutputs),
        classifyExpr(expr.right, patterns, deny, scope, cteNames, cteOutputs),
      ])
    case 'unary':
      return promoteDerived(classifyExpr(expr.operand, patterns, deny, scope, cteNames, cteOutputs))
    case 'ternary':
      return firstProtectedDerived([
        classifyExpr(expr.value, patterns, deny, scope, cteNames, cteOutputs),
        classifyExpr(expr.lo, patterns, deny, scope, cteNames, cteOutputs),
        classifyExpr(expr.hi, patterns, deny, scope, cteNames, cteOutputs),
      ])
    case 'case': {
      const parts: Classified[] = []
      if (expr.value) parts.push(classifyExpr(expr.value, patterns, deny, scope, cteNames, cteOutputs))
      for (const when of expr.whens) {
        parts.push(classifyExpr(when.when, patterns, deny, scope, cteNames, cteOutputs))
        parts.push(classifyExpr(when.value, patterns, deny, scope, cteNames, cteOutputs))
      }
      if (expr.else) parts.push(classifyExpr(expr.else, patterns, deny, scope, cteNames, cteOutputs))
      return firstProtectedDerived(parts)
    }
    case 'list':
    case 'array':
      return firstProtectedDerived(
        expr.expressions.map((item) => classifyExpr(item, patterns, deny, scope, cteNames, cteOutputs)),
      )
    case 'array select':
      return classifySubquery(expr.select, patterns, deny, cteNames, cteOutputs)
    case 'member': {
      const inner = classifyExpr(expr.operand, patterns, deny, scope, cteNames, cteOutputs)
      if (typeof expr.member === 'string') {
        const pattern = matchTableColumn(patterns, undefined, undefined, String(expr.member))
        if (pattern) {
          return {
            kind: 'protected',
            name: displayName(pattern, undefined, String(expr.member).toLowerCase()),
            derived: true,
            column: String(expr.member).toLowerCase(),
          }
        }
      }
      return promoteDerived(inner)
    }
    case 'extract':
      return promoteDerived(classifyExpr(expr.from, patterns, deny, scope, cteNames, cteOutputs))
    case 'overlay':
      return firstProtectedDerived([
        classifyExpr(expr.value, patterns, deny, scope, cteNames, cteOutputs),
        classifyExpr(expr.placing, patterns, deny, scope, cteNames, cteOutputs),
        classifyExpr(expr.from, patterns, deny, scope, cteNames, cteOutputs),
        ...(expr.for ? [classifyExpr(expr.for, patterns, deny, scope, cteNames, cteOutputs)] : []),
      ])
    case 'substring':
      return firstProtectedDerived([
        classifyExpr(expr.value, patterns, deny, scope, cteNames, cteOutputs),
        ...(expr.from ? [classifyExpr(expr.from, patterns, deny, scope, cteNames, cteOutputs)] : []),
        ...(expr.for ? [classifyExpr(expr.for, patterns, deny, scope, cteNames, cteOutputs)] : []),
      ])
    case 'arrayIndex':
      return firstProtectedDerived([
        classifyExpr(expr.array, patterns, deny, scope, cteNames, cteOutputs),
        classifyExpr(expr.index, patterns, deny, scope, cteNames, cteOutputs),
      ])
    case 'select':
    case 'with':
    case 'with recursive':
    case 'union':
    case 'union all':
    case 'values':
      return classifySubquery(expr, patterns, deny, cteNames, cteOutputs)
    default:
      return { kind: 'unknown' }
  }
}

function classifySubquery(
  statement: Statement | SelectStatement,
  patterns: string[],
  deny: (reason: string) => never,
  cteNames: Set<string>,
  cteOutputs: Map<string, Map<string, string>>,
): Classified {
  const outputs = walkRead(statement, patterns, deny, cteNames, cteOutputs)
  if (outputs.size === 0) return { kind: 'none' }
  const first = [...outputs.entries()][0]
  return { kind: 'protected', name: first[1], derived: true, column: first[0] }
}

function promoteDerived(inner: Classified): Classified {
  if (inner.kind === 'protected') return { ...inner, derived: true }
  return inner
}

function firstProtectedDerived(parts: Classified[]): Classified {
  for (const part of parts) {
    if (part.kind === 'unknown') return part
    if (part.kind === 'protected') return { ...part, derived: true }
  }
  return { kind: 'none' }
}

