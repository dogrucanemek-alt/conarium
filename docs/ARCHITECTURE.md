# Conarium architecture

## Thesis

MCP made "connect an AI assistant to your data" a commodity. The durable value is **not** the connection — it is everything an enterprise needs *around* the connection before it can safely let an AI read internal systems:

1. **Ingestion** of messy internal sources (schemas today; docs, ADRs, APIs next).
2. **Governance + audit** — what the AI may see, and a record of what it saw.
3. **Self-hosting** — data never leaves the customer's network.
4. **Freshness** — incremental re-index so context never goes stale.

Conarium owns this layer and stays **tool-agnostic**: it speaks MCP, so it plugs into Cursor, Copilot, Claude Code, Windsurf, Continue.dev — whatever wins.

## Request path

```
AI client ──MCP──▶ index.ts (tool dispatch)
                      │
                      ├─▶ Governance.allowsTable / guardQuery / maxRows / redact
                      ├─▶ Audit.log(decision)
                      └─▶ Connector (postgres | supabase | …)  ──▶ source system
```

Governance is enforced **before** the connector runs (table access, query shape) and **after** it returns (row cap, PII masking). Audit records the decision either way. A connector can never bypass the layer because the layer owns the tool handlers.

## Modules

| File | Responsibility |
|---|---|
| `src/index.ts` | MCP server, tool dispatch, wires governance + audit around every call |
| `src/governance.ts` | Policy: allow/deny tables, query guard, row caps, PII masking |
| `src/audit.ts` | Append-only JSONL audit of every tool call |
| `src/connectors/*` | Source adapters implementing the `Connector` interface |
| `src/types.ts` | Config, policy, schema and result contracts |

## Connector contract

A connector implements `listTables / describeTable / query / search`. It only knows how to *read a source*; it knows nothing about policy or audit. This keeps new connectors (docs, OpenAPI, Slack) cheap to add — they inherit governance for free.

## Design partner

ZION is the first connector and reference deployment: a live ERP with real schemas, real business rules (e.g. "use `price2`, not `price3`"), and real governance needs (mask customer PII, deny accounting-internal tables). It validates the layer against a real company before selling it to others.
