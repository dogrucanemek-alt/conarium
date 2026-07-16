#!/usr/bin/env node
/**
 * Conarium stdio entrypoint (local MCP for Cursor / Claude Code / Codex).
 * Server core lives in server.ts — shared with the remote HTTP entrypoint (http.ts).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig, bootDeps, buildServer } from './server.js'

async function main() {
  const config = loadConfig()
  const deps = await bootDeps(config)
  const server = buildServer(deps)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[conarium] MCP server running - ${deps.connectors.length} connector(s) active`)

  process.on('SIGINT', async () => {
    for (const conn of deps.connectors) await conn.disconnect().catch(() => {})
    process.exit(0)
  })
}

main().catch(err => {
  console.error('[conarium] Fatal:', err)
  process.exit(1)
})
