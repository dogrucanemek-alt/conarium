import { describe, it, expect, vi } from 'vitest'
import { maxRowsWarns, maskingCostWarning, warnIfMaxRowsHigh, MASKING_COST_WARN_ABOVE } from './masking-cost.js'
import { parseConariumConfig } from './config.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('masking-cost warning', () => {
  it('threshold matches the measured JSON', () => {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), 'docs/benchmarks/masking-cost-threshold.json'), 'utf8'),
    )
    expect(raw.warnAbove).toBe(MASKING_COST_WARN_ABOVE)
  })

  it('default and omitted stay silent; raised cap warns', () => {
    expect(maxRowsWarns(undefined)).toBe(false)
    expect(maxRowsWarns(100)).toBe(false)
    expect(maxRowsWarns(MASKING_COST_WARN_ABOVE)).toBe(false)
    expect(maxRowsWarns(MASKING_COST_WARN_ABOVE + 1)).toBe(true)
  })

  it('text names distinct values, not table size, and does not reject', () => {
    const text = maskingCostWarning(500)
    expect(text).toMatch(/distinct/)
    expect(text).toMatch(/not rejected/)
    expect(text).not.toMatch(/denied|refused|fail-closed/i)
  })

  it('parseConariumConfig warns on stderr and still returns the config', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cfg = parseConariumConfig({
      connectors: [],
      policy: { maxRows: 1000, allowTables: ['public.t'] },
    })
    expect(cfg.policy?.maxRows).toBe(1000)
    expect(err).toHaveBeenCalled()
    expect(err.mock.calls[0][0]).toMatch(/distinct/)
    err.mockRestore()
  })
})
