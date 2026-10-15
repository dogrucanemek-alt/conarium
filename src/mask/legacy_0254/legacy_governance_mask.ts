// Frozen copy of the 0.2.54 Governance.maskPII string and number branches. Do not edit.
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
  mergeByClass,
  type CompiledCustomPattern,
} from './custom_patterns.js'
import type { GovernancePolicy } from './types.js'
import { replaceConnectionCredentials } from './conn_linear.js'

/**
 * A capitalised run of one to three words — the shape of a written name once
 * something else has already told us a name is coming.
 */
const NAME_SHAPE = String.raw`\p{Lu}\p{L}+(?:\s+\p{Lu}\p{L}+){0,2}`

/** "Sn. Ahmet Yılmaz", "Dr. Ayşe Demir" — the title marks it, not a dictionary. */
const TITLED_NAME_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(Sn\.|Sayın|Sayin|Bayan|Bay|Mrs\.|Mr\.|Ms\.|Dr\.|Av\.|Prof\.)\s+(${NAME_SHAPE})`,
  'gu',
)

/**
 * "Yetkili: Ayşe Demir", "customer: John Smith" — the field label marks it.
 * The leading boundary is what keeps `filename: Rapor` out: the `name` inside
 * `filename` is preceded by a letter, so it never starts a match.
 */
const LABELLED_NAME_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(müşteri|musteri|yetkili|kişi|kisi|temsilci|adı soyadı|adi soyadi|ad soyad|customer|contact|full name|name)\s*:\s*(${NAME_SHAPE})`,
  'giu',
)

/** Column-name heuristic shared by nested JSON and flat query rows (G18). */
export function maskByColumnName(column: string): '[MASKED_PII]' | '[MASKED_SECRET]' | null {
  const leaf = column.slice(column.lastIndexOf('.') + 1).toLowerCase()
  // Split-TCKN keys (`tckn_1`/`tckn_2`) are decided by checksum pairing, not by name.
  if (/(?:tckn|tc_no|tcno|tc_kimlik)[._-]?(?:1|2|left|right|part[12]|a|b)$/i.test(leaf)) {
    return null
  }
  if (leaf.includes('email') || leaf.includes('phone') || leaf.includes('tckn') || leaf.includes('card') || leaf.includes('iban')) {
    return '[MASKED_PII]'
  }
  if (/secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|\bkey\b|credential/.test(leaf)) {
    return '[MASKED_SECRET]'
  }
  return null
}

export interface LegacyMaskOpts {
  policy: GovernancePolicy
  customPatterns: CompiledCustomPattern[]
  column?: string
}

export function legacyMaskPiiString(
  text: string,
  opts: LegacyMaskOpts,
): { masked: string; count: number; byClass: Record<string, number> } {
  if (!text) return { masked: text, count: 0, byClass: {} }
  const policy = opts.policy
  const customPatterns = opts.customPatterns
  const column = opts.column

  if (column) {
    const named = maskByColumnName(column)
    if (named) return { masked: named, count: 1, byClass: {} }
  }
  let count = 0;
  const byClass: Record<string, number> = {};
  // Fail-closed size cap: scanning a 40 KB digit field is O(n²) on the
  // unbounded email regex and blocks the event loop. Skipping the scan
  // would be the attack ("send 100 KB, skip masking"). The whole field
  // is masked instead; maskedCount records that a decision was made.
  if (text.length > resolveScanCharCap(policy.scanCharCap)) {
    return { masked: '[MASKED_PII]', count: 1, byClass: {} }
  }
  // Normalise first (ZWSP/homoglyph/fullwidth/unicode dash). The outgoing
  // string is this form even when nothing is PII — see pii_normalize.ts.
  let masked = normalizePiiText(text);

  // IBAN BEFORE digit detectors. The card/TCKN/phone regexes otherwise eat
  // the numeric tail and leave `TR00000000000[MASKED_PII]` — which looks
  // like protection and is the worse outcome. Checksum-fail lookalikes
  // are shielded until after those regexes, then restored unmasked.
  const ibanPass = prepareIbanPass(masked)
  masked = ibanPass.text
  count += ibanPass.count

  const emailPass = maskEmails(masked)
  masked = emailPass.text
  count += emailPass.count
  const entityPass = maskEntityEncodedEmails(masked)
  masked = entityPass.text
  count += entityPass.count
  const numPass = maskNumericPii(masked)
  masked = numPass.text
  count += numPass.count

  if (policy.detectors?.ip === true) {
    const ipPass = maskIps(masked)
    masked = ipPass.text
    count += ipPass.count
  }
  if (policy.detectors?.mrz !== false) {
    const mrzPass = maskMrz(masked)
    masked = mrzPass.text
    count += mrzPass.count
  }

  // Hardening (Codex review 2026-07-06, P1): README says "secrets are redacted in the
  // response stream" but the response path (maskPII) only caught PII — API key /
  // token / password / connection-string credentials went to the MODEL in the clear
  // (e.g. if the api_key column was not in maskColumns). The audit path
  // (audit.ts maskArgs) already caught these; we carried the same detectors onto
  // the response path. The product's security promise = this.
  // sk- family: new OpenAI keys are sk-proj-... (contain hyphens) → allow hyphen/underscore.
  // Secrets and labelled names need letters. A 12k-digit order field
  // otherwise still pays for those unicode regexes.
  if (/[A-Za-z]/.test(masked)) {
    const secretRe = /\b(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]{6,}|sk_test_[A-Za-z0-9]{6,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9._-]{20,})\b/g;
    masked = masked.replace(secretRe, () => { count++; return '[MASKED_SECRET]'; });
    // No credential match without "://"; the guard stays output-equivalent. Linear scan, same groups as the old expression.
    if (masked.includes('://')) masked = replaceConnectionCredentials(masked, (p1, p2) => { count++; return `${p1}[MASKED_SECRET]${p2}`; });
    masked = masked.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, (_m, p1) => { count++; return `${p1}[MASKED_SECRET]`; });
    masked = masked.replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)["'\s]*[:=]["'\s]*)[^"'\s,;}]{4,}/gi, (_m, p1) => { count++; return `${p1}[MASKED_SECRET]`; });
  }

  // LABELLED NAMES. A person's name is the one identifier this gateway could
  // not see: emails, national ids, phones and cards have shape, names do not.
  // Column policy caught `customer_name`; a name written into a free-text
  // note went to the model verbatim.
  //
  // What this does NOT do, deliberately: detect a bare name in running prose
  // ("Ahmet called yesterday"). That needs NER — a model, a dictionary and a
  // confidence score — and this gateway's whole claim is that its decisions
  // are deterministic and reproducible from the rule alone. Only names the
  // TEXT ITSELF marks as names, via a title or a field label, are masked.
  // The residual gap is documented rather than papered over.
  if (policy.maskLabelledNames !== false && /[\p{L}]/u.test(masked)) {
    masked = masked.replace(TITLED_NAME_RE, (_m, title: string) => {
      count++
      return `${title} [MASKED_PII]`
    })
    masked = masked.replace(LABELLED_NAME_RE, (_m, label: string) => {
      count++
      return `${label}: [MASKED_PII]`
    })
  }

  // Hardening (Claude, 2026-07-02): also catch PII smuggled via encode(...,'base64').
  // The NEO red-team harness found this hole (pii-base64 BYPASS). If a pure-base64
  // string decodes to email/TCKN, mask it.
  // Length-capped: a 12k-digit field matches `{12,}` and Buffer.from of
  // 12 kB of '1's was the leftover ~80 ms after the email regex was bounded.
  // Encoded TCKN/email/IBAN fit in well under 256 characters.
  const b64candidate = masked.trim();
  if (b64candidate.length <= 256 && /^[A-Za-z0-9+/]{12,}={0,2}$/.test(b64candidate)) {
    try {
      const decoded = Buffer.from(b64candidate, 'base64').toString('utf8');
      if (maskEmails(decoded).count > 0 || maskNumericPii(decoded).count > 0 || maskIbansInText(decoded).count > 0) {
        count++;
        masked = '[MASKED_PII]';
      }
    } catch { /* not base64 */ }
  }

  masked = ibanPass.restore(masked)

  // Backstop: a leftover country-code prefix glued to a mask is a partial
  // IBAN. Collapse it to a full mask so maskedCount cannot claim protection
  // while the prefix is still in the clear.
  const collapsed = collapsePartialMask(masked)
  if (collapsed !== masked) {
    masked = collapsed
    if (count === 0) count++
  }

  const encoded = maskEmbeddedEncodedPii(masked, (s) => maskIbansInText(s).count > 0)
  masked = encoded.text
  count += encoded.count

  // Operator patterns last: they catch formats the built-ins do not know.
  // Same scanner, same count. Receipt records the rule name, never the pattern.
  if (customPatterns.length > 0) {
    const custom = applyCustomPatterns(masked, customPatterns, column)
    masked = custom.text
    count += custom.count
    mergeByClass(byClass, custom.byClass)
  }

  return { masked, count, byClass };
}

export function legacyMaskPiiNumber(
  value: number | bigint,
  opts: LegacyMaskOpts,
): { masked: string | number | bigint; count: number; byClass: Record<string, number> } {
  if (!value) return { masked: value, count: 0, byClass: {} }
  const result = legacyMaskPiiString(String(value), opts)
  return result.count > 0 ? result : { masked: value, count: 0, byClass: {} }
}
