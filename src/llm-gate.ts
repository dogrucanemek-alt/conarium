import { Governance } from './governance.js';
import type { GovernancePolicy } from './types.js';

export type LlmFn = (prompt: string) => Promise<string>;

export interface GateAudit {
  at: string;
  promptChars: number;
  maskedCount: number;
}

/**
 * Conarium LLM gate: run the outgoing prompt through PII-mask + audit, THEN send it to the model.
 * Usage (jarvis-web/lib/konnektor/llm.ts):
 *   export const claudeLlm = governLlm(rawClaudeLlm, policy, a => appendAudit(a));
 *
 * NOTE (honest): maskPII catches: email (and &#64; / \\u0040 / %40 forms),
 * TCKN / phone / card, IBAN (mod-97), MRZ (TD3 checksum), secret patterns.
 * IP only when `policy.detectors.ip === true`. Street address and bare names
 * are not structural — column policy / conarium-suggest-policy.
 */
export function governLlm(
  llm: LlmFn,
  policy: GovernancePolicy = {},
  onAudit?: (a: GateAudit) => void
): LlmFn {
  const gov = new Governance(policy);
  return async (prompt: string): Promise<string> => {
    const res = gov.maskPII(prompt) as { masked: unknown; count: number };
    const masked = typeof res.masked === 'string' ? res.masked : prompt;
    onAudit?.({ at: new Date().toISOString(), promptChars: prompt.length, maskedCount: res.count });
    return llm(masked);
  };
}
