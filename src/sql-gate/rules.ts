/**
 * Shared gate rules. Dialect-independent decisions.
 * A new dialect must not copy these lists — it must call them.
 */

export const WRITE_TOKENS = [
  'DROP ', 'TRUNCATE ', 'DELETE ', 'UPDATE ', 'INSERT ', 'ALTER ', 'CREATE ',
  'GRANT ', 'REVOKE ', 'MERGE ', 'COPY ', 'CALL ', 'DO ', 'VACUUM ',
] as const

export const SAFE_BUILTIN_FUNCTIONS = new Set([
  'abs',
  'avg',
  'btrim',
  'ceil',
  'ceiling',
  'char_length',
  'coalesce',
  'concat',
  'concat_ws',
  'convert_to',
  'count',
  'encode',
  'floor',
  'greatest',
  'least',
  'length',
  'lower',
  'ltrim',
  'max',
  'min',
  'nullif',
  'octet_length',
  'regexp_replace',
  'regexp_split_to_array',
  'replace',
  'round',
  'rtrim',
  'split_part',
  'sum',
  'trim',
  'upper',
])

export const BLOCKED_DUMP_FUNCTIONS = new Set([
  'array_agg',
  'json_agg',
  'jsonb_agg',
  'row_to_json',
  'string_agg',
])

export function normalizedSqlHead(sql: string): string {
  return ` ${sql.trim().toUpperCase().replace(/\s+/g, ' ')} `
}

export function isSelectOrWith(norm: string): boolean {
  const head = norm.trimStart()
  return head.startsWith('SELECT') || head.startsWith('WITH')
}

export function findWriteToken(norm: string): string | undefined {
  for (const tok of WRITE_TOKENS) {
    const regex = new RegExp(`\\b${tok.trim()}\\b`)
    if (regex.test(norm)) return tok.trim()
  }
  return undefined
}

export function hasRowLockClause(norm: string): boolean {
  return /\bFOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/.test(norm)
}

export function isSafeBuiltinFunction(baseName: string, schema?: string): boolean {
  return SAFE_BUILTIN_FUNCTIONS.has(baseName) && (!schema || schema === 'pg_catalog')
}

export function isBlockedDumpFunction(baseName: string): boolean {
  return BLOCKED_DUMP_FUNCTIONS.has(baseName)
}
