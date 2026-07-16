import { z } from 'zod'
import type { ConariumConfig } from './types.js'

const stringArray = z.array(z.string().min(1)).default([])

export const GovernancePolicySchema = z.object({
  allowTables: stringArray.optional(),
  denyTables: stringArray.optional(),
  maskColumns: stringArray.optional(),
  maxRows: z.number().int().positive().max(10000).optional(),
  allowTools: stringArray.optional(),
  denyTools: stringArray.optional(),
  allowConnectors: stringArray.optional(),
  denyConnectors: stringArray.optional(),
}).strict()

export const AuditConfigSchema = z.object({
  sink: z.string().min(1).optional(),
  failClosed: z.boolean().optional(),
}).strict()

export const ConnectorConfigSchema = z.object({
  type: z.enum(['postgres', 'supabase', 'supabase-rest', 'openapi', 'files', 'docs', 'slack', 'jira']),
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
}).strict()

export function parseConariumConfig(raw: unknown): ConariumConfig {
  return ConariumConfigSchema.parse(raw)
}
