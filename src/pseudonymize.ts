export interface PseudoResult {
  /** Text with names inside replaced by tokens (this is what goes to the LLM). */
  text: string;
  /** token → real name. AUDIT/internal use ONLY — NEVER goes to the LLM. */
  map: Record<string, string>;
  /** How many unique names were pseudonymized. */
  count: number;
}

/**
 * Replace KNOWN names in the text (customer/supplier/employee) with stable tokens.
 * The same name maps to the same token everywhere → the LLM can reason consistently
 * ("Record #1 is in debt + Record #1 spent 5000") without knowing the real identity.
 *
 * ZION integration (assistant/route.ts): when building ctx, pass names through here:
 *   const { text, map } = pseudonymizeText(ctx, [...customerNames, ...supplierNames], 'Kayıt');
 *   appendAudit({ pseudoMap: map });  // token→name to audit, ctx (text) to the LLM.
 */
export function pseudonymizeText(text: string, names: string[], kind = 'Kayıt'): PseudoResult {
  // 3+ chars, unique, LONGEST names first (prevents partial overlap)
  const uniq = [...new Set(names.map(s => (s || '').trim()).filter(s => s.length >= 3))]
    .sort((a, b) => b.length - a.length);

  const map: Record<string, string> = {};
  let out = text;
  let n = 0;
  for (const real of uniq) {
    n++;
    const token = `${kind} #${n}`;
    map[token] = real;
    out = out.split(real).join(token); // replace every occurrence
  }
  return { text: out, map, count: uniq.length };
}
