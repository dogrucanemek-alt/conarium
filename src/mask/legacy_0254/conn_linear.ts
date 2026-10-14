/**
 * Linear stand-in for
 * `/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@\s/"']+:)[^@\s/"']+(@)/g`.
 *
 * The scheme star retries every letter of a long run and rescans it, which is
 * quadratic. Each "://" has one candidate: the leftmost ASCII letter of the
 * scheme run that touches that separator, clipped so it does not start before
 * the resume index. The host is the following run that stops at ":", the
 * password the run that stops at "@". A hit resumes just after that "@" — the
 * same place `String.prototype.replace` continues — and a miss tries the next
 * "://". Neither quantifier can succeed by giving characters back (`:`, `@`
 * are outside those classes), so the leftmost candidate is the only one.
 * Text and replacer groups are locked to the expression by
 * src/mask/conn_linear.test.ts.
 */

export interface ConnectionCredential {
  /** Leftmost scheme letter at or after the resume index. */
  schemeStart: number
  /** Exclusive end of group 1 (the colon after the host). Password starts here. */
  group1End: number
  /** Index of the closing `@`. */
  at: number
}

export function forEachConnectionCredential(
  text: string,
  visit: (match: ConnectionCredential) => void,
): void {
  const n = text.length
  let resume = 0
  while (resume < n) {
    const sep = text.indexOf('://', resume)
    if (sep < 0) return

    let schemeStart = sep
    while (schemeStart > resume && isSchemeCode(text.charCodeAt(schemeStart - 1))) schemeStart--
    while (schemeStart < sep && !isAsciiLetter(text.charCodeAt(schemeStart))) schemeStart++
    if (schemeStart >= sep) {
      resume = sep + 1
      continue
    }

    let k = sep + 3
    const hostStart = k
    while (k < n && isHostCode(text.charCodeAt(k))) k++
    if (k === hostStart || k >= n || text.charCodeAt(k) !== 58) {
      resume = sep + 1
      continue
    }
    k += 1
    const group1End = k
    while (k < n && isPassCode(text.charCodeAt(k))) k++
    if (k === group1End || k >= n || text.charCodeAt(k) !== 64) {
      resume = sep + 1
      continue
    }

    visit({ schemeStart, group1End, at: k })
    resume = k + 1
  }
}

export function replaceConnectionCredentials(
  text: string,
  replacer: (group1: string, group2: string) => string,
): string {
  let cursor = 0
  let changed = false
  const parts: string[] = []
  forEachConnectionCredential(text, (match) => {
    changed = true
    parts.push(text.slice(cursor, match.schemeStart))
    parts.push(String(replacer(text.slice(match.schemeStart, match.group1End), '@')))
    cursor = match.at + 1
  })
  if (!changed) return text
  parts.push(text.slice(cursor))
  return parts.join('')
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isSchemeCode(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57) || code === 43 || code === 45 || code === 46
}

/** JavaScript `\s`: WhiteSpace or LineTerminator, BMP code units. */
function isJsWhitespace(code: number): boolean {
  return (
    code === 9 ||
    code === 10 ||
    code === 11 ||
    code === 12 ||
    code === 13 ||
    code === 32 ||
    code === 0xa0 ||
    code === 0x1680 ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff ||
    (code >= 0x2000 && code <= 0x200a)
  )
}

function isHostCode(code: number): boolean {
  return code !== 58 && code !== 64 && code !== 47 && code !== 34 && code !== 39 && !isJsWhitespace(code)
}

function isPassCode(code: number): boolean {
  return code !== 64 && code !== 47 && code !== 34 && code !== 39 && !isJsWhitespace(code)
}
