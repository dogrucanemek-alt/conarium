/**
 * Numeric PII — card / TCKN / phone — with the same class of fix IBAN got
 * in 0.2.2: never start a match in the middle of a longer digit run.
 *
 * The card regex `(?:\d[ -]*?){13,16}` plus a phone regex with no leading
 * `\b` would match 13 digits *inside* a 16-digit PAN and leave
 * `411[MASKED_PII]`. `maskedCount` then claimed the field was protected.
 * A leftover prefix glued to a mask is not protection.
 *
 * Decision, on a *maximal* digit run (grouping spaces/hyphens allowed):
 *   - 13–16 digits and Luhn holds → card, mask the whole run
 *   - 11 digits starting with 0 → TR national phone (0 + 10 digits:
 *     cep 05xx, sabit 02/03/04xx, 08xx). TCKN never starts with 0.
 *     The 2nd-digit 5-vs-2/3/4 split is numbering-plan identity, not a
 *     masking decision — 08xx would fall through it.
 *   - 11 digits starting 1–9 → TCKN-shaped, mask the whole run
 *   - 10 digits → phone-shaped (compact local, no trunk 0)
 *   - longer (20, 25, …) → not a card; the content scanner does not touch it
 * Formatted phones (`+90 555 123 4567`) are a separate pass that also
 * refuses to start or end next to a digit.
 */
export const PII_SCAN_CHAR_CAP = 16_384
/** Hard ceiling so an unbounded cap cannot become a DoS. */
export const PII_SCAN_CHAR_CAP_MAX = 1_048_576

/**
 * Env wins, then policy, then the compiled default. Invalid env falls back
 * to default rather than disabling the cap.
 */
export function resolveScanCharCap(policyCap?: number): number {
  const env = process.env.CONARIUM_SCAN_CHAR_CAP
  if (env !== undefined && env !== '') {
    if (!/^\d+$/.test(env)) return PII_SCAN_CHAR_CAP
    const n = Number(env)
    if (n < 1) return PII_SCAN_CHAR_CAP
    return Math.min(n, PII_SCAN_CHAR_CAP_MAX)
  }
  if (typeof policyCap === 'number' && Number.isInteger(policyCap) && policyCap >= 1) {
    return Math.min(policyCap, PII_SCAN_CHAR_CAP_MAX)
  }
  return PII_SCAN_CHAR_CAP
}

export function luhnOk(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (n < 0 || n > 9) return false
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

const isDigit = (c: string) => c >= '0' && c <= '9'
const isGroup = (c: string) => c === ' ' || c === '-' || c === '.' || c === '/'
const isWord = (c: string) => /[A-Za-z0-9_]/.test(c)

function isolatedSpan(s: string, start: number, end: number): boolean {
  const left = start === 0 ? '' : s[start - 1]
  const right = end >= s.length ? '' : s[end]
  // A digit neighbour means this is a slice of a longer run — refuse.
  if (isDigit(left) || isDigit(right)) return false
  // Prefix letter/`_` never hides (`x4111…`, `ref_0532…`).
  // Suffix: one trailing letter is the G15 twin (`4111…x`). More word
  // characters after that (`ghp_1234567890abcd`) stay a token, not a phone.
  if (right && /[A-Za-z_]/.test(right)) {
    const after = end + 1 < s.length ? s[end + 1] : ''
    if (after && isWord(after)) return false
  }
  return true
}

/** `11.22.33.44.55` / `1.2.3.4` — dotted 1–3 digit groups, not a PAN/phone. */
function looksLikeDottedIpOrVersion(s: string, start: number, end: number): boolean {
  const slice = s.slice(start, end)
  if (!/[./]/.test(slice)) return false
  const groups = slice.split(/[./]/).filter((g) => g.length > 0)
  if (groups.length < 4) return false
  return groups.every((g) => /^\d{1,3}$/.test(g))
}

/**
 * Formatted voice numbers. Lookahead/lookbehind are the boundary rule:
 * a match that has a digit on either side is a slice of a longer run and
 * is not taken. Expanding it would make it "the whole run"; that run is
 * then classified below, not here.
 */
const PHONE_FORMATTED =
  /(?<!\d)(?:\+?\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g

export function maskNumericPii(text: string): { text: string; count: number } {
  let count = 0
  let out = text
  if (/[+()\s-]/.test(text)) {
    out = text.replace(PHONE_FORMATTED, (m) => {
      if (/^\d+$/.test(m)) return m
      count++
      return '[MASKED_PII]'
    })
  }

  // Count digits in the run first. Concatenating 12k chars one-by-one is
  // O(n²) in JS and was the leftover cost after the email regex was bounded.
  const parts: string[] = []
  let i = 0
  while (i < out.length) {
    if (!isDigit(out[i])) {
      const ns = i
      while (i < out.length && !isDigit(out[i])) i++
      parts.push(out.slice(ns, i))
      continue
    }
    const start = i
    let n = 0
    while (i < out.length) {
      if (isDigit(out[i])) {
        n++
        i++
        continue
      }
      if (isGroup(out[i]) && i + 1 < out.length && isDigit(out[i + 1])) {
        i++
        continue
      }
      break
    }
    if (
      isolatedSpan(out, start, i)
      && !looksLikeDottedIpOrVersion(out, start, i)
      && classifyDigitRun(out, start, i, n)
    ) {
      count++
      // isolatedSpan accepted one trailing letter (`4111…x`) — swallow it
      // so the mask is the whole token, not `[MASKED_PII]x`.
      if (i < out.length && /[A-Za-z_]/.test(out[i])) {
        const after = i + 1 < out.length ? out[i + 1] : ''
        if (!after || !isWord(after)) i += 1
      }
      parts.push('[MASKED_PII]')
    } else {
      parts.push(out.slice(start, i))
    }
  }
  return { text: parts.join(''), count }
}

function collectDigits(s: string, start: number, end: number): string {
  let d = ''
  for (let j = start; j < end; j++) {
    if (isDigit(s[j])) d += s[j]
  }
  return d
}

function classifyDigitRun(s: string, start: number, end: number, n: number): boolean {
  if (n === 11) {
    const first = s[start]
    if (first === '0') return true
    return first >= '1' && first <= '9'
  }
  if (n === 10) return true
  if (n === 9) {
    // Formatted US SSN only (AAA-GG-SSSS). Bare 9-digit runs collide with
    // order IDs — see LIMITATIONS.
    return /^\d{3}-\d{2}-\d{4}$/.test(s.slice(start, end))
  }
  if (n >= 13 && n <= 16) return luhnOk(collectDigits(s, start, end))
  return false
}

/** Bounded email. Unbounded `{local}+@` backtracks O(n²) on a long
 *  alphanumeric field that contains no `@` (TR33+40k digits, 20k hex). */
export const EMAIL_RE =
  /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,253}\.[a-zA-Z]{2,24}/g

export function maskEmails(text: string): { text: string; count: number } {
  if (!text.includes('@')) return { text, count: 0 }
  let count = 0
  const next = text.replace(EMAIL_RE, () => {
    count++
    return '[MASKED_PII]'
  })
  return { text: next, count }
}

/**
 * `contact&#64;x.com` / `\u0040` / `%40` is an email the `@` detector never
 * sees. Matching is *for the scan only*: if the encoded `@` is not part of
 * an email-shaped token, the original bytes stay. A blanket rewrite would
 * corrupt HTML (`5&#64; magaza`) and Windows paths (`C:\path\u0040abc`).
 * One pass only — `&amp;#64;` is not chased.
 */
const ENCODED_AT = String.raw`(?:&#0*64;|&#x0*40;|&commat;|\\u0040|%40)`
const ENTITY_EMAIL = new RegExp(
  `[a-zA-Z0-9._%+-]{1,64}${ENCODED_AT}[a-zA-Z0-9.-]{1,253}\\.[a-zA-Z]{2,24}`,
  'gi',
)
const ENCODED_AT_HINT = /&#0*64;|&#x0*40;|&commat;|\\u0040|%40/i

export function maskEntityEncodedEmails(text: string): { text: string; count: number } {
  if (!ENCODED_AT_HINT.test(text)) return { text, count: 0 }
  let count = 0
  const next = text.replace(ENTITY_EMAIL, () => {
    count++
    return '[MASKED_PII]'
  })
  return { text: next, count }
}
