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
  /[A-Za-z]{2}[\s-]*\d{2}(?:[\s-]*[A-Za-z0-9]){11,30}/g

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
  // ⛔ One candidate regex with String.replace is not enough. Measured:
  // "IBAN1 and IBAN2" collapses into a single match — the [\s-]* that allows
  // grouping spaces counts the word between them as alphanumeric too — and then
  // the {11,30} bound cuts the match IN THE MIDDLE OF THE SECOND IBAN
  // ("...841326 and TR33 00"). Because replace resumes at the END of a match,
  // the remainder of the second IBAN never matched any pattern again: every text
  // carrying two IBANs produced count=1 and left the second one FULLY exposed.
  // "from account X to account Y" is an ordinary sentence in payment text, so
  // this is not an edge case.
  //
  // Fix: find an anchor → collect the longest IBAN-shaped run from there (34
  // alphanumerics at most) → shrink from the end until the checksum holds → and
  // resume scanning immediately after the CONSUMED span. So even when an
  // over-greedy run swallows the second IBAN, the cursor returns to its start.
  const ANCHOR = /[A-Za-z]{2}[\s-]*\d{2}/g
  const isAlnum = (c: string) => /[A-Za-z0-9]/.test(c)
  const isSep = (c: string) => /[\s-]/.test(c)

  const runFrom = (s: string, start: number): string => {
    let i = start
    let alnum = 0
    let end = start
    while (i < s.length && alnum < 34) {
      if (isAlnum(s[i])) {
        alnum++
        i++
        end = i
        continue
      }
      if (isSep(s[i])) {
        let j = i
        while (j < s.length && isSep(s[j])) j++
        if (j < s.length && isAlnum(s[j]) && alnum < 34) {
          i = j
          continue
        }
      }
      break
    }
    return s.slice(start, end)
  }

  let out = ''
  let cursor = 0
  ANCHOR.lastIndex = 0
  let anchor: RegExpExecArray | null
  while ((anchor = ANCHOR.exec(text)) !== null) {
    if (anchor.index < cursor) {
      ANCHOR.lastIndex = cursor
      continue
    }
    const run = runFrom(text, anchor.index)
    if (run.length < 15) {
      ANCHOR.lastIndex = anchor.index + 1
      continue
    }
    const valid = longestWhere(run, (n) => looksLikeIban(n) && (!checksum || ibanMod97Ok(n)))
    const shape = valid ?? longestWhere(run, looksLikeIban)
    const atWordBoundary = anchor.index === 0 || !/[A-Za-z0-9_]/.test(text[anchor.index - 1])
    if (!shape || (!valid && !atWordBoundary)) {
      // Glued prefix (`acctTR33…`): mask only a checksum-valid IBAN.
      // Do not shield lookalikes — that hid cards (`kart 4111…`) and MRZ.
      ANCHOR.lastIndex = anchor.index + 1
      continue
    }
    out += text.slice(cursor, anchor.index)
    if (valid) {
      count++
      out += IBAN_MASK
    } else {
      const id = holes.length
      holes.push(shape)
      out += `${SHIELD_OPEN}${id}${SHIELD_CLOSE}`
    }
    cursor = anchor.index + shape.length
    ANCHOR.lastIndex = cursor
  }
  const next = out + text.slice(cursor)
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
