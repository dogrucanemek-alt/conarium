/**
 * TCKN checksum (Algorithmic Identity Number). Used only for the *split*
 * detector: two similarly named fields on the same row whose digits join
 * to a checksum-valid 11-digit TCKN.
 *
 * The content scanner's 11-digit run still does NOT require this checksum —
 * existing vectors use `12345678901`, which fails it. Changing that would
 * unmask those vectors and look like a regression.
 *
 * No combinatorial scan of every field × every field.
 */
export function tcknChecksumOk(digits: string): boolean {
  if (!/^[1-9]\d{10}$/.test(digits)) return false
  const n = Array.from(digits, (c) => c.charCodeAt(0) - 48)
  const odd = n[0] + n[2] + n[4] + n[6] + n[8]
  const even = n[1] + n[3] + n[5] + n[7]
  const d10 = (((odd * 7 - even) % 10) + 10) % 10
  if (n[9] !== d10) return false
  const d11 = n.slice(0, 10).reduce((a, b) => a + b) % 10
  return n[10] === d11
}

const TCKN_KEY = /(?:^|[._-])(?:tckn|tc_no|tcno|tc_kimlik)(?:$|[._-])/i

function tcknStem(key: string): string {
  return key.toLowerCase().replace(/[._-]?(?:1|2|left|right|part[12]|a|b)$/i, '')
}

function digitsOf(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    return ''
  }
  return String(value).replace(/\D/g, '')
}

/**
 * Pair similarly named TCKN-like keys on one row. Concatenation (either
 * order) must checksum. Returns the number of fields masked.
 */
export function maskSplitTcknFields(row: Record<string, unknown>): {
  count: number
  maskedKeys: string[]
} {
  const keys = Object.keys(row).filter((k) => TCKN_KEY.test(k))
  if (keys.length < 2) return { count: 0, maskedKeys: [] }
  const used = new Set<string>()
  const maskedKeys: string[] = []
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i]
      const b = keys[j]
      if (used.has(a) || used.has(b)) continue
      if (tcknStem(a) !== tcknStem(b)) continue
      const da = digitsOf(row[a])
      const db = digitsOf(row[b])
      if (!da || !db) continue
      const hit = tcknChecksumOk(da + db) || tcknChecksumOk(db + da)
      if (!hit) continue
      row[a] = '[MASKED_PII]'
      row[b] = '[MASKED_PII]'
      used.add(a)
      used.add(b)
      maskedKeys.push(a, b)
    }
  }
  return { count: maskedKeys.length, maskedKeys }
}
