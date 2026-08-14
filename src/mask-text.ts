/**
 * Shared PII/secret masking pipeline. Audit args, error text, and (later)
 * reason/target/governance all go through this — one copy, not three.
 */
import { maskIbansInText, prepareIbanPass } from './iban.js'
import {
  collapsePartialMask,
  maskEmbeddedEncodedPii,
  normalizePiiText,
} from './pii_normalize.js'
import {
  resolveScanCharCap,
  maskEmails,
  maskEntityEncodedEmails,
  maskNumericPii,
} from './digit_pii.js'
import { maskIps } from './ip_detect.js'
import { maskMrz } from './mrz.js'
import {
  applyCustomPatterns,
  type CompiledCustomPattern,
} from './custom_patterns.js'
import type { DetectorToggles } from './types.js'

export interface MaskTextOptions {
  scanCharCap?: number
  detectors?: DetectorToggles
  customPatterns?: CompiledCustomPattern[]
}

export function maskSensitiveText(text: string, opts: MaskTextOptions = {}): string {
  if (text.length > resolveScanCharCap(opts.scanCharCap)) {
    return '[MASKED_PII]'
  }
  let masked = normalizePiiText(text)
  const ibanPass = prepareIbanPass(masked)
  masked = ibanPass.text
  masked = maskEmails(masked).text
  masked = maskEntityEncodedEmails(masked).text
  masked = maskNumericPii(masked).text
  if (opts.detectors?.ip === true) masked = maskIps(masked).text
  if (opts.detectors?.mrz !== false) masked = maskMrz(masked).text
  masked = masked.replace(/\b(?:sk-[A-Za-z0-9]{12,}|sk_live_[A-Za-z0-9]{6,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9._-]{20,})\b/g, '[MASKED_SECRET]')
  masked = masked.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@\s/"']+:)[^@\s/"']+(@)/g, '$1[MASKED_SECRET]$2')
  masked = masked.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[MASKED_SECRET]')
  masked = masked.replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)["'\s]*[:=]["'\s]*)[^"'\s,;}]{4,}/gi, '$1[MASKED_SECRET]')
  masked = ibanPass.restore(masked)
  masked = collapsePartialMask(masked)
  masked = maskEmbeddedEncodedPii(masked, (s) => maskIbansInText(s).count > 0).text
  if (opts.customPatterns && opts.customPatterns.length > 0) {
    masked = applyCustomPatterns(masked, opts.customPatterns).text
  }
  return masked
}
