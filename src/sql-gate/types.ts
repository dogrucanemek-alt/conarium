/**
 * Questions every SQL dialect must answer. The AST type is not shared.
 * pgsql-ast-parser is an input, not a decision.
 *
 * A dialect that only implements `inspect` is not supported. Support means
 * the C vector set is green against that dialect. This file is the contract.
 */

export type SqlDialectId = 'postgres' | 'mssql' | 'oracle'

export interface DialectQuestions {
  /** 0 when parse failed. */
  statementCount: number
  /** schema.table, already folded the way that dialect folds. */
  tables: string[]
  /** Output / referenced column names the adapter could name. */
  columns: string[]
  writes: boolean
  functions: string[]
  /** True when the adapter saw a native row-limit node it understands. */
  hasRowLimitNode: boolean
  parseFailed: boolean
  parseError?: string
}

export interface DialectAdapter {
  readonly dialect: SqlDialectId
  /**
   * Fail-closed: unparseable input sets parseFailed. It does not throw
   * past the gate, and it does not invent an empty analysis.
   */
  inspect(sql: string): DialectQuestions
}
