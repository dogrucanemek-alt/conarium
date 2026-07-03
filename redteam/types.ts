import type { Governance } from '../src/governance.js';

export type AttackCategory = 'write_smuggle' | 'unauthorized_table' | 'multi_statement' | 'pii_exfil';
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM';

export interface AttackCase {
  id: string;
  category: AttackCategory;
  severity: Severity;
  description: string;
  run(gov: Governance): { defended: boolean; detail: string };
}

export interface AttackResult {
  id: string;
  category: AttackCategory;
  severity: Severity;
  description: string;
  defended: boolean;
  detail: string;
}

export interface RedTeamReport {
  ranAt: string;
  total: number;
  defended: number;
  bypassed: number;
  results: AttackResult[];
}
