/**
 * Pure dialect / engine helpers for conarium-doctor.
 * Kept out of src/ so the doctor still runs when the build is broken.
 * No DSN, no pattern text, no secrets.
 */

export const DOCTOR_DIALECTS = ['postgres', 'mssql', 'oracle']

/** Missing → postgres (today's path). Typo / mysql → throw. No silent fallback. */
export function resolveDoctorDialect(value) {
  if (value === undefined) return { dialect: 'postgres', source: 'default' }
  if (value === 'postgres' || value === 'mssql' || value === 'oracle') {
    return { dialect: value, source: 'declared' }
  }
  const shown = typeof value === 'string' ? value : typeof value
  throw new Error(`policy.dialect "${shown}" is not allowed. Use postgres, mssql, or oracle.`)
}

export function familyFromScheme(scheme) {
  const s = String(scheme || '').toLowerCase().replace(/:$/, '')
  if (s === 'postgres' || s === 'postgresql') return 'postgres'
  if (s === 'mssql' || s === 'sqlserver' || s === 'microsoft-sql-server') return 'mssql'
  if (s === 'oracle' || s === 'oracledb') return 'oracle'
  return null
}

/** Banner / version() text → family. Unknown stays unknown — never guessed into a match. */
export function familyFromBanner(text) {
  const t = String(text || '')
  if (/postgresql/i.test(t) || /\bpostgres\b/i.test(t)) return 'postgres'
  if (/microsoft sql server/i.test(t) || /\bsql server\b/i.test(t)) return 'mssql'
  if (/\boracle\b/i.test(t)) return 'oracle'
  return null
}

export function dialectAgrees(dialect, family) {
  if (!family) return false
  return dialect === family
}

/** One line the operator can paste. Never include a DSN or password. */
export function dialectLine(dialect, source) {
  if (source === 'default') {
    return `${dialect} (default — policy.dialect omitted)`
  }
  return `${dialect} (declared in policy.dialect)`
}
