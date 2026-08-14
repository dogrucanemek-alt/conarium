import { parse, toSql } from 'pgsql-ast-parser'
import type { SelectFromStatement, SelectStatement, Statement } from 'pgsql-ast-parser'
import type { DialectAdapter, DialectQuestions } from './types.js'

export function parsePostgresSql(sql: string): Statement[] {
  return parse(sql)
}

export function emitPostgresSql(statement: Statement): string {
  return toSql.statement(statement)
}

export function postgresLimitTarget(
  statement: Statement | SelectStatement,
): SelectFromStatement | undefined {
  if (statement.type === 'select') return statement
  if (statement.type === 'with' || statement.type === 'with recursive') {
    return postgresLimitTarget(statement.in)
  }
  return undefined
}

export function applyPostgresRowCap(
  statement: Statement | SelectStatement,
  cap: number,
): void {
  const target = postgresLimitTarget(statement)
  if (!target) return

  const existing = target.limit?.limit as { type?: string; value?: number } | undefined
  // Never RAISE a limit the caller already set below the cap — a request for
  // 1 row must not become 50. Only clamp down; preserve any OFFSET.
  if (existing && existing.type === 'integer' && typeof existing.value === 'number' && existing.value <= cap) {
    return
  }
  target.limit = {
    ...(target.limit ?? {}),
    limit: { type: 'integer', value: cap },
  }
}

/**
 * Answers the shared questions. Lineage / mask carry-over still walks the
 * Postgres AST in Governance — that walk is Postgres-shaped on purpose.
 */
export const postgresAdapter: DialectAdapter = {
  dialect: 'postgres',
  inspect(sql: string): DialectQuestions {
    try {
      const ast = parsePostgresSql(sql)
      return {
        statementCount: ast.length,
        tables: [],
        columns: [],
        writes: false,
        functions: [],
        hasRowLimitNode: ast.length === 1 && postgresLimitTarget(ast[0]) !== undefined,
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
