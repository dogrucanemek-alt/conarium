/**
 * Operator-declared SQL gate. The dialect is never inferred from the statement.
 * Guessing from attacker-controlled SQL would pick the parser for them.
 */
import type { GuardedQuery } from '../governance.js'
import type { GovernancePolicy } from '../types.js'
import type { SqlDialectId } from './types.js'

export const SQL_DIALECTS = ['postgres', 'mssql', 'oracle'] as const
export type SqlDialect = SqlDialectId

type DialectGate = (sql: string, policy: GovernancePolicy) => GuardedQuery

const extraGates = new Map<Exclude<SqlDialect, 'postgres'>, DialectGate>()

export function registerSqlGate(
  dialect: Exclude<SqlDialect, 'postgres'>,
  gate: DialectGate,
): void {
  extraGates.set(dialect, gate)
}

/** Missing → postgres. Anything else (typo, case, mysql) throws. No silent fallback. */
export function resolveSqlDialect(value: unknown): SqlDialect {
  if (value === undefined) return 'postgres'
  if (value === 'postgres' || value === 'mssql' || value === 'oracle') return value
  const shown = typeof value === 'string' ? value : typeof value
  throw new Error(
    `Conarium: policy.dialect "${shown}" is not allowed. Use postgres, mssql, or oracle.`,
  )
}

export async function loadSqlGate(dialect: SqlDialect): Promise<void> {
  if (dialect === 'mssql') await import('./mssql.js')
  if (dialect === 'oracle') await import('./oracle.js')
}

export function guardSqlByDialect(
  dialect: SqlDialect,
  sql: string,
  policy: GovernancePolicy,
  postgresGuard: (sql: string) => GuardedQuery,
): GuardedQuery {
  if (dialect === 'postgres') return postgresGuard(sql)
  const gate = extraGates.get(dialect)
  if (!gate) {
    throw new Error(
      `Conarium: the ${dialect} SQL gate is not loaded. Set policy.dialect and boot through loadConfig/bootDeps.`,
    )
  }
  return gate(sql, policy)
}
