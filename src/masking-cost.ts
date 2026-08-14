/**
 * Measured masking-cost warning. Not a security gate.
 *
 * Carry-over builds one matcher per distinct masked value. Cost grows with
 * that count, which `maxRows` caps. Default maxRows stays silent.
 * Raising the cap is allowed — we say so on stderr and in the doctor.
 *
 * Threshold comes from docs/benchmarks/masking-cost-threshold.json
 * (measured, not invented). Keep the number here in sync; test/masking_cost_warn.test.ts
 * checks both.
 */
export const MASKING_COST_WARN_ABOVE = 100

export function maxRowsWarns(maxRows: number | undefined): boolean {
  if (maxRows == null) return false
  return maxRows > MASKING_COST_WARN_ABOVE
}

export function maskingCostWarning(maxRows: number): string {
  return (
    `policy.maxRows is ${maxRows} (measured warning above ${MASKING_COST_WARN_ABOVE}). ` +
    `Masking cost grows with the number of distinct values this policy already masked, ` +
    `not with table size. The row cap bounds that set. Default ${MASKING_COST_WARN_ABOVE} ` +
    `stayed in the low-millisecond band on the published bench; 500 distinct emails ` +
    `were tens of milliseconds; 1 000 were hundreds. This is a performance warning. ` +
    `The query is not rejected.`
  )
}

export function warnIfMaxRowsHigh(maxRows: number | undefined): void {
  if (!maxRowsWarns(maxRows) || maxRows == null) return
  console.error(`[conarium:policy] ${maskingCostWarning(maxRows)}`)
}
