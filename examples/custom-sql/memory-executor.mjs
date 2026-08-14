/**
 * In-memory reference executor. No extra npm dependency.
 *
 * Conarium will only call `execute` with SQL that already passed the gate.
 * This sample ignores the statement and returns every row on purpose — the
 * gateway still applies the row cap and the mask. A real operator passes
 * the gated SQL to their own driver (mssql, oracledb, snowflake, …).
 */
const ROWS = Array.from({ length: 80 }, (_, i) => ({
  id: i + 1,
  email: `user${i + 1}@example.com`,
}))

export async function execute(_sql) {
  return { rows: ROWS, fields: ['id', 'email'] }
}
