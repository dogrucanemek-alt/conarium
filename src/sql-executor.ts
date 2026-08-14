/**
 * Operator-supplied SQL runner. Conarium does not ship MSSQL/Oracle (or any
 * other) drivers — this is the hook. The function must never see raw assistant
 * SQL; only CustomSqlConnector.runGoverned() calls it, and that method is
 * reached only after Governance.guardSql() on the MCP `query` tool.
 */
import { pathToFileURL } from 'url'
import { resolve } from 'path'
import type { QueryResult } from './types.js'

export type SqlExecutorFn = (sql: string) => Promise<unknown> | unknown

const registry = new Map<string, SqlExecutorFn>()

export function registerSqlExecutor(name: string, execute: SqlExecutorFn): void {
  if (!name.trim()) {
    throw new Error('Conarium: registerSqlExecutor requires a connector name.')
  }
  if (typeof execute !== 'function') {
    throw new Error('Conarium: registerSqlExecutor requires an execute function.')
  }
  registry.set(name, execute)
}

export function lookupSqlExecutor(name: string): SqlExecutorFn | undefined {
  return registry.get(name)
}

/** Test isolation. Production code does not need this. */
export function resetSqlExecutorsForTests(): void {
  registry.clear()
}

export function assertLocalModuleSpec(spec: string): void {
  const trimmed = spec.trim()
  if (!trimmed) {
    throw new Error('Conarium: custom-sql config.module is empty.')
  }
  // Windows drive (`C:\…`) is a path. `http:`, `file:`, `data:`, `node:` are not.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new Error('Conarium: custom-sql config.module must be a local file path.')
  }
}

export async function loadExecutorModule(spec: string): Promise<SqlExecutorFn> {
  assertLocalModuleSpec(spec)
  const abs = resolve(process.cwd(), spec)
  const mod = await import(pathToFileURL(abs).href) as {
    execute?: unknown
    default?: { execute?: unknown } | SqlExecutorFn
  }
  const fn =
    (typeof mod.execute === 'function' ? mod.execute : undefined) ??
    (mod.default && typeof mod.default === 'object' && typeof mod.default.execute === 'function'
      ? mod.default.execute
      : undefined) ??
    (typeof mod.default === 'function' ? mod.default : undefined)
  if (typeof fn !== 'function') {
    throw new Error('Conarium: custom-sql module must export execute(sql).')
  }
  return fn as SqlExecutorFn
}

/**
 * Normalise whatever the operator returned. Their claimed `rowCount` is
 * ignored — a lying executor must not shrink the cap check.
 */
export function normalizeExecutorResult(raw: unknown): QueryResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Conarium: custom-sql executor must return an object with rows.')
  }
  const rows = (raw as { rows?: unknown }).rows
  if (!Array.isArray(rows)) {
    throw new Error('Conarium: custom-sql executor rows must be an array.')
  }
  const normalized: Record<string, unknown>[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('Conarium: custom-sql executor each row must be an object.')
    }
    normalized.push(row as Record<string, unknown>)
  }
  const fieldsRaw = (raw as { fields?: unknown }).fields
  const fields = Array.isArray(fieldsRaw)
    ? fieldsRaw.map((f) => String(f))
    : Object.keys(normalized[0] ?? {})
  return { rows: normalized, rowCount: normalized.length, fields }
}
