/**
 * Content-scanner normalisation — runs BEFORE IBAN / digit / email detectors.
 *
 * Invisible and look-alike characters were splitting identifiers so the IBAN
 * scanner never fired, then the digit scanner ate the tail and left
 * `TR33<ZWSP>000610051[MASKED_PII]` — which looks like protection, increments
 * `maskedCount`, and still hands the prefix to the model. That is the failure
 * this pass exists to prevent.
 *
 * Conscious output change: the string that leaves the scanner is the
 * normalised form even when nothing was PII. Zero-width / format characters
 * are stripped; fullwidth digits and `＠` become ASCII; unicode dashes become
 * ASCII hyphen. The model and the operator see the same bytes. A ZWSP that
 * was only there to hide an IBAN is gone; a ZWSP that was only there as
 * decoration is also gone. Documented, tested, not silent.
 */
export function normalizePiiText(input: string): string {
  let s = input
  // ZWSP, ZWNJ, ZWJ, BOM, soft hyphen
  s = s.replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, '')
  s = s.replace(/\uFF20/g, '@') // fullwidth commercial at
  s = s.replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30))
  s = s.replace(/[\u2010-\u2015\u2212]/g, '-')
  return s
}

/**
 * If a digit detector still left a country-code prefix glued to a mask
 * (`TR33000610051[MASKED_PII]`), that is a partial mask. Collapse it to a
 * full mask so the audit count cannot claim a field was protected while the
 * prefix remains. Prefer the IBAN pass firing first; this is the backstop.
 */
export function collapsePartialIbanMask(text: string): string {
  return text.replace(/[A-Z]{2}\d{2,12}\[MASKED_PII\]/g, '[MASKED_PII]')
}

export function decodedLooksLikePii(decoded: string): boolean {
  const n = normalizePiiText(decoded)
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(n)) return true
  if (/\b[1-9][0-9]{10}\b/.test(n)) return true
  return false
}

/**
 * Mask *tokens inside a field* that decode to PII. Whole-field base64 is
 * handled separately. Length-capped so a 20 kB image blob is not scanned.
 * Non-PII payloads (hashes, greetings, signatures) are left alone.
 */
export function maskEmbeddedEncodedPii(
  text: string,
  ibanHit: (s: string) => boolean,
): { text: string; count: number } {
  let count = 0
  let out = text

  out = out.replace(
    /(?<![A-Za-z0-9+/])([A-Za-z0-9+/]{16,80}={0,2})(?![A-Za-z0-9+/=])/g,
    (token) => {
      if (token.includes('[MASKED')) return token
      try {
        const decoded = Buffer.from(token, 'base64').toString('utf8')
        if (!decoded || decoded.includes('\u0000')) return token
        if (decodedLooksLikePii(decoded) || ibanHit(decoded)) {
          count++
          return '[MASKED_PII]'
        }
      } catch { /* not base64 */ }
      return token
    },
  )

  out = out.replace(/\b([0-9A-Fa-f]{24,80})\b/g, (token) => {
    if (token.length % 2 !== 0) return token
    try {
      const decoded = Buffer.from(token, 'hex').toString('utf8')
      if (!decoded || decoded.includes('\u0000')) return token
      if (decodedLooksLikePii(decoded) || ibanHit(decoded)) {
        count++
        return '[MASKED_PII]'
      }
    } catch { /* not hex */ }
    return token
  })

  return { text: out, count }
}
