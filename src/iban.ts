/**
 * IBAN content detector — deterministic, checksummed, not overridable.
 *
 * Column policy (`maskColumns: ['*.iban']`) only fires when the column is
 * named. A free-text note, or a column the operator forgot to list, used to
 * send the IBAN to the model — sometimes half-masked by the digit detector
 * (`TR00000000000[MASKED_PII]`), which looks like protection and is worse
 * than leaving it alone.
 *
 * A profile may empty `maskColumns`. It must not switch this off: identity
 * fields are not a privilege the controller can grant the model.
 *
 * Checksum (ISO 7064 mod-97-10) is the false-positive brake. Shape alone
 * would mask any 15–34 character alphanumeric run that starts with two
 * letters; the remainder-1 test is what refuses a random 26-digit string.
 * Tests that disable the checksum MUST go red if this brake is removed.
 *
 * The candidate regex is greedy and will eat the next word (`havale IBAN
 * tamam`). After a match we shrink from the end until the remainder is a
 * real IBAN (or an IBAN-shaped lookalike). Lookalikes that fail checksum
 * are not masked — they are shielded so the phone/card regexes cannot
 * nibble the tail.
 */
export const IBAN_MASK = '[MASKED_PII]' as const

const SHIELD_OPEN = '\uE000'
const SHIELD_CLOSE = '\uE001'

/** Strip grouping spaces/hyphens; IBAN letters are case-insensitive. */
export function normalizeIban(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}

/**
 * ISO 13616 electronic form: 2-letter country, 2 check digits, 11–30 BBAN.
 * Country-specific lengths are not a dictionary we maintain — checksum is
 * the acceptance test.
 */
export function looksLikeIban(normalized: string): boolean {
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalized)
}

/**
 * ISO 7064 MOD-97-10 over the rearranged IBAN.
 * Remainder must be 1. A candidate that fails this is not an IBAN.
 */
export function ibanMod97Ok(normalized: string): boolean {
  const rearranged = normalized.slice(4) + normalized.slice(0, 4)
  let rem = 0
  for (const ch of rearranged) {
    const piece = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of piece) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97
  }
  return rem === 1
}

export interface MaskIbanOpts {
  /** Production default true. Tests flip this to prove the brake exists. */
  checksum?: boolean
}

/**
 * Country letters + check digits, then 11–30 grouped alphanumerics.
 * Spaces/hyphens inside the body are the common written form.
 * No trailing `\b`: we shrink the greedy match ourselves.
 */
const IBAN_CANDIDATE =
  /\b[A-Za-z]{2}[\s-]*\d{2}(?:[\s-]*[A-Za-z0-9]){11,30}/g

function trimTrailingIbanChar(s: string): string {
  return s.replace(/[\s-]*[A-Za-z0-9]$/i, '')
}

function longestWhere(raw: string, pred: (normalized: string) => boolean): string | null {
  let candidate = raw
  while (candidate.length >= 15) {
    if (pred(normalizeIban(candidate))) return candidate
    const next = trimTrailingIbanChar(candidate)
    if (next === candidate) break
    candidate = next
  }
  return null
}

export interface IbanPass {
  text: string
  count: number
  restore: (s: string) => string
}

/**
 * Mask checksum-valid IBANs; shield remaining IBAN-shaped spans so later
 * digit detectors cannot half-mask them. Call `restore` after those detectors.
 */
export function prepareIbanPass(text: string, opts: MaskIbanOpts = {}): IbanPass {
  const checksum = opts.checksum !== false
  const holes: string[] = []
  let count = 0
  const next = text.replace(IBAN_CANDIDATE, (m) => {
    const valid = longestWhere(m, (n) => looksLikeIban(n) && (!checksum || ibanMod97Ok(n)))
    if (valid) {
      count++
      return IBAN_MASK + m.slice(valid.length)
    }
    const shape = longestWhere(m, looksLikeIban)
    if (!shape) return m
    const id = holes.length
    holes.push(shape)
    return `${SHIELD_OPEN}${id}${SHIELD_CLOSE}` + m.slice(shape.length)
  })
  return {
    text: next,
    count,
    restore: (s) => s.replace(
      new RegExp(`${SHIELD_OPEN}(\\d+)${SHIELD_CLOSE}`, 'g'),
      (_, id: string) => holes[Number(id)] ?? _,
    ),
  }
}

export function maskIbansInText(text: string, opts: MaskIbanOpts = {}): { text: string; count: number } {
  const pass = prepareIbanPass(text, opts)
  return { text: pass.restore(pass.text), count: pass.count }
}
