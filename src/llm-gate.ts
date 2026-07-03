import { Governance } from './governance.js';
import type { GovernancePolicy } from './types.js';

export type LlmFn = (prompt: string) => Promise<string>;

export interface GateAudit {
  at: string;
  promptChars: number;
  maskedCount: number;
}

/**
 * Conarium LLM kapısı: giden prompt'u PII-maske + audit'ten geçirir, SONRA modele iletir.
 * Kullanım (jarvis-web/lib/konnektor/llm.ts):
 *   export const claudeLlm = governLlm(rawClaudeLlm, policy, a => appendAudit(a));
 *
 * NOT (dürüst): maskPII regex'i email/TCKN/telefon/kart yakalar. AD/UNVAN gibi
 * yapısal PII regex'e uymaz → onlar ctx üretim kaynağında pseudonymize edilmeli (Faz 2).
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
