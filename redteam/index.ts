import { Governance } from '../src/governance.js';
import type { GovernancePolicy } from '../src/types.js';
import type { AttackCase, RedTeamReport } from './types.js';
import { queryTimeAttacks } from './attacks/queryTime.js';
import { resultTimeAttacks } from './attacks/resultTime.js';
import { runRedTeam } from './runner.js';
import { renderMarkdown } from './report.js';

export const allAttacks: AttackCase[] = [...queryTimeAttacks, ...resultTimeAttacks];

export function redTeamConarium(policy: GovernancePolicy): RedTeamReport {
  return runRedTeam(new Governance(policy), allAttacks);
}

// CLI: npx tsx redteam/index.ts
const isMain = import.meta.url === `file://${process.argv[1]}` || (process.argv[1]?.endsWith('index.ts') ?? false);
if (isMain) {
  const rep = redTeamConarium({ allowTables: ['public.customers'], maskColumns: ['*.email'], maxRows: 100 });
  console.log(renderMarkdown(rep));
}
