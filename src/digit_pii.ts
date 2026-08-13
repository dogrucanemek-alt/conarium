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
 *   - 11 digits starting 1–9 → TCKN-shaped, mask the whole run
 *   - 10 digits → phone-shaped (compact local), mask the whole run
 *   - longer (20, 25, …) → not a card; the content scanner does not touch it
 * Formatted phones (`+90 555 123 4567`) are a separate pass that also
 * refuses to start or end next to a digit.
 */
export const PII_SCAN_CHAR_CAP = 16_384

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
const isGroup = (c: string) => c === ' ' || c === '-'
const isWord = (c: string) => /[A-Za-z0-9_]/.test(c)

function isolatedSpan(s: string, start: number, end: number): boolean {
  const left = start === 0 ? '' : s[start - 1]
  const right = end >= s.length ? '' : s[end]
  return !isWord(left) && !isWord(right)
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
    if (isolatedSpan(out, start, i) && classifyDigitRun(out, start, i, n)) {
      count++
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
    return first >= '1' && first <= '9'
  }
  if (n === 10) return true
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
 * `contact&#64;x.com` is an email the `@` detector never sees. Decode is
 * *for the scan only*: if the entity is not part of an email, the original
 * bytes stay. A blanket `&#64;` → `@` rewrite would corrupt HTML.
 */
const ENTITY_EMAIL =
  /[a-zA-Z0-9._%+-]{1,64}(?:&#64;|&#x0*40;|&commat;)[a-zA-Z0-9.-]{1,253}\.[a-zA-Z]{2,24}/gi

export function maskEntityEncodedEmails(text: string): { text: string; count: number } {
  if (!/&#64;|&#x0*40;|&commat;/i.test(text)) return { text, count: 0 }
  let count = 0
  const next = text.replace(ENTITY_EMAIL, () => {
    count++
    return '[MASKED_PII]'
  })
  return { text: next, count }
}
