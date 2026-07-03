import type { Connector, ConnectorConfig } from '../types.js'
import { PostgresConnector } from './postgres.js'
import { ZionConnector } from './zion.js'
import { DocsConnector } from './docs.js'
import { OpenApiConnector } from './openapi.js'
import { SlackConnector } from './slack.js'
import { JiraConnector } from './jira.js'
import { ConnectorConfigSchema } from '../config.js'

export { PostgresConnector } from './postgres.js'
export { ZionConnector } from './zion.js'
export { DocsConnector } from './docs.js'
export { OpenApiConnector } from './openapi.js'
export { SlackConnector } from './slack.js'
export { JiraConnector } from './jira.js'

export function createConnector(config: ConnectorConfig): Connector {
  const parsed = ConnectorConfigSchema.parse(config)
  switch (parsed.type) {
    case 'postgres':
      return new PostgresConnector(parsed)
    case 'supabase':
      return new ZionConnector(parsed)
    case 'docs':
      return new DocsConnector(parsed)
    case 'openapi':
      return new OpenApiConnector(parsed)
    case 'slack':
      return new SlackConnector(parsed)
    case 'jira':
      return new JiraConnector(parsed)
    default:
      throw new Error(`Unknown connector type: ${parsed.type}. Supported: postgres, supabase, docs, openapi, slack, jira`)
  }
}
