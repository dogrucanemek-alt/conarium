/**
 * Library entry: `@conarium-ai/core/mask`.
 *
 * The package root is the stdio server and runs main() on import. This entry
 * is the masking engine alone, for a program that wants to mask a value
 * without starting anything: importing it starts no server and opens no
 * stream (test/mask_entry.mjs). It is the same pipeline the server uses.
 *
 * maskField returns the masked text, how many regions were masked, `classes`
 * (how many spans of each class it found) and `masked` (what it replaced, or
 * `{ whole: 1 }` when the whole field went). `only` lists the classes to mask
 * and leaves the rest; the counts never carry the values.
 */
export {
  maskField,
  maskSensitiveText,
  type MaskFieldOptions,
  type MaskTextOptions,
} from './mask-text.js'
export {
  compileCustomPatterns,
  type CompiledCustomPattern,
  type CustomPatternReject,
} from './custom_patterns.js'
export type { CustomPiiPattern, DetectorToggles } from './types.js'
export type { SpanClass } from './mask/core.js'
