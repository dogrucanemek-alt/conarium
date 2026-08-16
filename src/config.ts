import { z } from 'zod'
import type { ConariumConfig } from './types.js'
import { compileCustomPatterns, CustomPatternError } from './custom_patterns.js'
import { warnIfMaxRowsHigh } from './masking-cost.js'
import { assertProtectedColumnsSupported } from './protected-columns.js'

const stringArray = z.array(z.string().min(1)).default([])

const MaskingProfileSchema = z.object({
  // No .default([]): an omitted maskColumns must stay omitted so the overlay
  // does not silently empty the base list.
  maskColumns: z.array(z.string().min(1)).optional(),
  maxRows: z.number().int().positive().max(10000).optional(),
  maskLabelledNames: z.boolean().optional(),
}).strict()

const CustomPatternSchema = z.object({
  name: z.string().min(1),
  pattern: z.string().min(1),
  columns: z.array(z.string().min(1)).optional(),
  label: z.string().min(1).optional(),
  // Doctor-only. The gateway ignores it. Same sensitivity as `pattern`.
  sample: z.string().min(1).optional(),
}).strict()

export const GovernancePolicySchema = z.object({
  allowTables: stringArray.optional(),
  denyTables: stringArray.optional(),
  maskColumns: stringArray.optional(),
  // Same glob syntax as maskColumns. Not on MaskingProfileSchema — a profile
  // that could drop this field would be a per-person back door. .strict()
  // on the profile schema rejects the key if it is added there.
  protectedColumns: stringArray.optional(),
  maxRows: z.number().int().positive().max(10000).optional(),
  dialect: z.enum(['postgres', 'mssql', 'oracle']).optional(),
  maskLabelledNames: z.boolean().optional(),
  allowTools: stringArray.optional(),
  denyTools: stringArray.optional(),
  allowConnectors: stringArray.optional(),
  denyConnectors: stringArray.optional(),
  // These exist on Governance and in README. Until they were on this schema,
  // loadConfig() threw Unrecognized key and the gateway could not boot a
  // profiled config — the feature worked only when tests constructed the
  // class by hand.
  profiles: z.record(MaskingProfileSchema).optional(),
  actorProfiles: z.record(z.string().min(1)).optional(),
  scanCharCap: z.number().int().min(1).max(1_048_576).optional(),
  // Identity detectors (TCKN, card, IBAN, email, phone, PAN) are intentionally
  // absent. Turning them off from config would let a bank "solve" masking by
  // disabling it — the product would contradict its own guarantee. .strict()
  // rejects those keys (and any other unrecognised detector name).
  detectors: z.object({
    ip: z.boolean().optional(),
    mrz: z.boolean().optional(),
  }).strict().optional(),
  customPatterns: z.array(CustomPatternSchema).optional(),
}).strict()

export const AuditConfigSchema = z.object({
  sink: z.string().min(1).optional(),
  failClosed: z.boolean().optional(),
  receiptSink: z.string().min(1).optional(),
  receiptModel: z.object({
    provider: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
  }).optional(),
  receiptClient: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }).optional(),
  /** Operator-declared destination (e.g. "openai/gpt-x"). Not verified. Not a policy input. */
  receiptDestination: z.string().min(1).optional(),
}).strict()

export const ConnectorConfigSchema = z.object({
  type: z.enum(['postgres', 'supabase', 'supabase-rest', 'openapi', 'files', 'docs', 'slack', 'jira', 'custom-sql']),
  name: z.string().min(1),
  description: z.string().min(1),
  config: z.record(z.string()).default({}),
}).strict()

export const ConariumConfigSchema = z.object({
  connectors: z.array(ConnectorConfigSchema),
  serverName: z.string().min(1).optional(),
  serverVersion: z.string().min(1).optional(),
  consumer: z.string().min(1).optional(),
  policy: GovernancePolicySchema.optional(),
  audit: AuditConfigSchema.optional(),
  profile: z.literal('production').optional(),
}).strict()

export function isProductionProfile(cfg?: { profile?: string } | null): boolean {
  if ((process.env.CONARIUM_PROFILE || '').toLowerCase() === 'production') return true
  return cfg?.profile === 'production'
}

/** Fail-closed production proof profile. Missing keys refuse boot. */
export function enforceProductionProfile(cfg?: { profile?: string } | null): void {
  if (!isProductionProfile(cfg)) return
  const missing: string[] = []
  if (!process.env.CONARIUM_AUDIT_SIGNING_KEY?.trim()) missing.push('CONARIUM_AUDIT_SIGNING_KEY (Ed25519)')
  if (!process.env.CONARIUM_AUDIT_HMAC_KEY?.trim()) missing.push('CONARIUM_AUDIT_HMAC_KEY')
  if (missing.length) {
    throw new Error(`production profile refuses boot: missing ${missing.join(' and ')}`)
  }
  if (process.env.CONARIUM_AUDIT_REQUIRE_SIG !== '1') {
    process.env.CONARIUM_AUDIT_REQUIRE_SIG = '1'
    process.stderr.write('[conarium] production profile: enabling CONARIUM_AUDIT_REQUIRE_SIG=1\n')
  }
  const sink = (process.env.CONARIUM_ANCHOR_SINK || 'none').toLowerCase()
  if (sink === 'none' || sink === '' || sink === 'off') {
    process.env.CONARIUM_ANCHOR_SINK = 'opentimestamps'
    process.stderr.write(
      '[conarium] production profile: anchor sink not set → enabling opentimestamps (outbound HTTPS to public calendars)\n',
    )
  }
}

/** Default 0 (unchanged). Production profile: 60 unless explicitly 0. */
export function resolveHttpRatePerMin(cfg?: { profile?: string } | null): number {
  const raw = process.env.CONARIUM_MCP_RATE_PER_MIN
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  return isProductionProfile(cfg) ? 60 : 0
}

export function parseConariumConfig(raw: unknown): ConariumConfig {
  let cfg: ConariumConfig
  try {
    cfg = ConariumConfigSchema.parse(raw)
  } catch (err) {
    if (err instanceof z.ZodError) throw sanitizeCustomPatternZod(err)
    throw err
  }
  // Compile here so loadConfig() fails closed before the process serves.
  // Governance / Audit compile again; a hand-built policy cannot skip this.
  try {
    compileCustomPatterns(cfg.policy?.customPatterns)
  } catch (err) {
    if (err instanceof CustomPatternError) throw err
    throw err
  }
  warnIfMaxRowsHigh(cfg.policy?.maxRows)
  for (const profile of Object.values(cfg.policy?.profiles ?? {})) {
    warnIfMaxRowsHigh(profile.maxRows)
  }
  assertCustomSqlDialect(cfg)
  assertProtectedColumnsSupported(cfg.policy)
  return cfg
}

/**
 * A plugged-in executor is an unknown engine. Applying the omitted-dialect
 * postgres default would parse that engine with the Postgres gate — a silent
 * hole. custom-sql therefore requires an explicit policy.dialect.
 */
export function assertCustomSqlDialect(cfg: ConariumConfig): void {
  if (!cfg.connectors.some((c) => c.type === 'custom-sql')) return
  const d = cfg.policy?.dialect
  if (d === 'postgres' || d === 'mssql' || d === 'oracle') return
  throw new Error(
    'Conarium: a custom-sql connector requires an explicit policy.dialect (postgres, mssql, or oracle). ' +
      'The omitted-dialect postgres default does not apply — that would parse an unknown engine with the Postgres gate.',
  )
}

/** Zod's default text can echo the received value. Pattern and sample must not leak. */
function sanitizeCustomPatternZod(err: z.ZodError): Error {
  const hit = err.issues.find(
    (i) =>
      i.path.includes('customPatterns') &&
      (i.path.includes('pattern') || i.path.includes('sample')),
  )
  if (!hit) return err
  const nameIdx = hit.path.indexOf('customPatterns')
  const ruleIndex = hit.path[nameIdx + 1]
  const shown = typeof ruleIndex === 'number' ? `#${ruleIndex}` : 'unknown'
  return new CustomPatternError(shown, 'invalid')
}
