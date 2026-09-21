#!/usr/bin/env node
/**
 * Conarium stdio entrypoint (local MCP for Cursor / Claude Code / Codex).
 *
 * This file always runs main(): it is reached directly, through the npm bin
 * link, and by being imported from bin/conarium-docker-entry.mjs, and in the last
 * two process.argv[1] is not this file. The logic lives in cli.ts, which starts
 * nothing on import.
 */
import { main } from './cli.js'

main().catch((err) => {
  console.error('[conarium] Fatal:', err)
  process.exit(1)
})
