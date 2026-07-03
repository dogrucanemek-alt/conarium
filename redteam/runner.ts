import type { Governance } from '../src/governance.js';
import type { AttackCase, AttackResult, RedTeamReport } from './types.js';

export function runRedTeam(gov: Governance, attacks: AttackCase[], now: Date = new Date()): RedTeamReport {
  const results: AttackResult[] = attacks.map(atk => {
    const { defended, detail } = atk.run(gov);
    return { id: atk.id, category: atk.category, severity: atk.severity, description: atk.description, defended, detail };
  });
  return {
    ranAt: now.toISOString(),
    total: results.length,
    defended: results.filter(r => r.defended).length,
    bypassed: results.filter(r => !r.defended).length,
    results,
  };
}
