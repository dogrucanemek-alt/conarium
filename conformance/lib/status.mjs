/**
 * Two regimes. Mixing their words is how a suite starts lying.
 *
 * conformance → PASS / FAIL (frozen expectation matched or not)
 * resistance  → ENFORCED | BOUNDED | NOT_COVERED | DECLARED_ONLY |
 *               DETECTED_WITH_EXTERNAL_PIN | NOT_CLAIMED
 *               never PASS
 */

export const RESISTANCE_STATUSES = [
  'ENFORCED',
  'BOUNDED',
  'NOT_COVERED',
  'DECLARED_ONLY',
  'DETECTED_WITH_EXTERNAL_PIN',
  'NOT_CLAIMED',
]

export function claimed(claimsFile, claim) {
  return (claimsFile.claims || []).includes(claim)
}

export function resistanceStatus({ allowed, expectedStatus, claimListed }) {
  if (!claimListed) return 'NOT_CLAIMED'
  if (expectedStatus && expectedStatus !== 'ENFORCED' && expectedStatus !== 'BOUNDED') {
    return expectedStatus
  }
  if (allowed === false) return 'ENFORCED'
  if (expectedStatus === 'BOUNDED') return 'BOUNDED'
  return 'NOT_COVERED'
}

export function conformanceStatus({ ok }) {
  return ok ? 'PASS' : 'FAIL'
}

export function label(regime, status) {
  if (regime === 'resistance' && status === 'PASS') {
    throw new Error('resistance regime must not use PASS')
  }
  return status
}

export function noScore(report) {
  if (report.score != null || report.percent != null || report.grade != null) {
    throw new Error('GACS must not produce a single score')
  }
}
