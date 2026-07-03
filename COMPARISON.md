# Conarium vs. The Alternatives

When deciding how to connect your AI coding assistants (Cursor, GitHub Copilot, Claude) to your internal company knowledge, you have a few options. Here is why **Conarium** is the superior choice for enterprises.

## 1. Conarium vs. Mintlify MCP (MintMCP)
Mintlify's MCP offering is primarily focused on public documentation and lacks deep integration with internal databases and strict governance controls.

**Why Conarium wins:**
*   **Data-Content Governance:** MintMCP simply serves files. Conarium inspects the *content* of the data returning from databases (like Postgres) and APIs, applying row caps and dynamic PII masking (`[MASKED_PII]`) before the AI even sees it.
*   **Auditability:** Conarium maintains a strict, append-only JSONL audit log of exactly what your AI searched for, what tool it used, and how many rows were returned, ensuring SOC2 compliance.

## 2. Conarium vs. Databricks AI / Unity Catalog
Databricks offers incredible governance for data scientists, but it's a massive, heavyweight platform.

**Why Conarium wins:**
*   **Self-Hosted & Lightweight:** Conarium is a single, lightweight Node.js/TypeScript binary that you can run locally or deploy in seconds. Databricks requires a massive cloud footprint.
*   **Developer-Centric:** Conarium is designed specifically as an MCP server to sit directly between a developer's IDE (like Cursor) and the company's internal tools (Docs, Postgres, Jira, Slack). It's built for the coding workflow, not data engineering.

## 3. Conarium vs. DIY (Do It Yourself) Scripts
Many companies try to write their own custom MCP servers.

**Why Conarium wins:**
*   **Platform-Agnostic & Multi-Source:** DIY scripts usually target one specific database. Conarium comes out-of-the-box with an extensible `Connector` interface, seamlessly blending Postgres, local Docs, Jira, Slack, and OpenAPI into a unified, governed endpoint.
*   **Out-of-the-box UI:** Conarium includes a beautiful, glassmorphism web console (`/api/config`) out-of-the-box to manage allow/deny lists and view audit logs without touching JSON configs manually.
*   **Security Assurances:** Writing a custom script that accidentally leaks your entire `secrets` table to an LLM is a career-ending mistake. Conarium has built-in `guardQuery` and `redact` functions battle-tested for exactly this threat model.
