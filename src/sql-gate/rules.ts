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
  'listagg',
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

/** Drop quoted literals so `SELECT 'DELETE ' FROM t` is not a write. */
export function stripSqlStringLiterals(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
}

export function findWriteToken(norm: string): string | undefined {
  const scan = stripSqlStringLiterals(norm)
  for (const tok of WRITE_TOKENS) {
    const regex = new RegExp(`\\b${tok.trim()}\\b`)
    if (regex.test(scan)) return tok.trim()
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

/** Same deny text as the Postgres gate — dialects must not invent their own. */
export function denyUnsafeFunction(baseName: string, schema?: string): string | undefined {
  const id = schema ? `${schema}.${baseName}` : baseName
  if (isBlockedDumpFunction(baseName)) {
    return `High-risk aggregate/serialization function '${id}' is not permitted by policy.`
  }
  if (!isSafeBuiltinFunction(baseName, schema)) {
    return `Function '${id}' is not permitted by policy.`
  }
  return undefined
}

/** Strip line and block comments without touching quoted strings. */
export function stripSqlComments(sql: string): string {
  let out = ''
  let i = 0
  let inSingle = false
  while (i < sql.length) {
    const c = sql[i]
    const n = sql[i + 1]
    if (inSingle) {
      out += c
      if (c === "'" && n === "'") {
        out += n
        i += 2
        continue
      }
      if (c === "'") inSingle = false
      i += 1
      continue
    }
    if (c === "'") {
      inSingle = true
      out += c
      i += 1
      continue
    }
    if (c === '-' && n === '-') {
      i += 2
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1
      out += ' '
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      if (i < sql.length) i += 2
      out += ' '
      continue
    }
    out += c
    i += 1
  }
  return out
}
