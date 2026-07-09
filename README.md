<div align="center">
  <h1>Conarium</h1>
  <p><strong>The Third Eye for Your Company's Data.</strong></p>
  <p>A self-hosted, governed gateway that lets AI coding assistants (Cursor, Copilot, Claude) touch your real data—without exposing a single secret.</p>
  
  <p>
    <a href="https://conarium.dev"><img src="https://img.shields.io/badge/Website-conarium.dev-5a8cff?style=for-the-badge" alt="Website" /></a>
    <a href="https://github.com/dogrucanemek-alt/conarium/releases"><img src="https://img.shields.io/github/v/release/dogrucanemek-alt/conarium?style=for-the-badge&color=6fe0e0" alt="Release" /></a>
    <a href="https://github.com/dogrucanemek-alt/conarium/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-f2d79a?style=for-the-badge" alt="License" /></a>
    <img src="https://img.shields.io/badge/Status-Early%20Access-ff6f80?style=for-the-badge" alt="Early Access" />
  </p>
</div>

<br/>

## 👁️ The Problem

Point Cursor or Copilot at a production database and it drinks the raw stream—SSNs, credit cards, salaries, and live keys. One rogue prompt can expose your most sensitive tables. Security teams simply can't allow that.

## 🛡️ The Solution: Conarium

Conarium acts as a high-performance **MCP (Model Context Protocol) Proxy**. It sits directly between the AI Assistant and your databases, evaluating policies in milliseconds to enforce row limits and mask PII (Personally Identifiable Information) on the wire.

The AI gets the context it needs to write code, but never sees your secrets.

### Key Features

- **Inline PII Masking:** Emails, IDs, cards, and secrets are redacted in the response stream (`[MASKED]`) before the model sees a single character.
- **Allow / Deny Lists:** Whitelist what AI can access. Your `secrets` and `financials` tables stay invisible.
- **Row Caps:** Hard per-query limits. Prevent the silent exfiltration of millions of rows. 
- **Immutable Audit Ledger:** Every access is logged (who, what, when, rows, decision). SOC2 & GDPR-ready, with no raw PII ever written to the logs.
- **100% Self-Hosted:** Runs entirely on your infrastructure. Your data never crosses your perimeter. 
- **MCP-Native:** Works out of the box with **Cursor**, **GitHub Copilot**, **Claude Code**, and **Windsurf**.

---

## 🏗️ Architecture (The Trifecta)

Conarium operates on a strict tripartite architecture, balancing power between three pillars:

```mermaid
graph LR
    A([AI Assistant\nCursor / Copilot]) -- "MCP Query" --> B{The Gateway\nConarium Proxy};
    B -- "Intercept & Parse" --> C[The Engine\nGovernance & Regex];
    C -- "Execute Query" --> D[(Your Database\nPostgres)];
    D -- "Raw Data" --> C;
    C -- "Mask & Cap" --> B;
    B -- "Sanitized Data" --> A;
    C -. "Write Log" .-> E[The Ledger\nAudit DB];
    
    style A fill:#05070f,stroke:#5a8cff,stroke-width:2px,color:#fff
    style B fill:#05070f,stroke:#ff6f80,stroke-width:2px,color:#fff
    style C fill:#05070f,stroke:#6fe0e0,stroke-width:2px,color:#fff
    style D fill:#05070f,stroke:#f2d79a,stroke-width:2px,color:#fff
    style E fill:#05070f,stroke:#838dad,stroke-width:2px,color:#fff
```

1. **The Gateway:** A proxy that speaks fluently to LLM assistants.
2. **The Engine:** Evaluates JSON policies, regex scans, and row caps in milliseconds.
3. **The Ledger:** An immutable audit log recording every query and decision.

---

## ⚡ Try It in 60 Seconds (no database needed)

See the full governance story — raw data → masked PII → blocked `secrets` table → hash-chained audit trail — with a single command:

```bash
git clone https://github.com/dogrucanemek-alt/conarium.git
cd conarium
npm install
npx tsx demo.ts
```

Want the visual console instead? Run `npx tsx start-console.ts` and open http://localhost:3000.

## 🚀 Quick Start

Conarium runs from source today. _(A one-command `npx conarium` CLI is on the [Roadmap](#️-roadmap).)_

```bash
# 1. Clone & install
git clone https://github.com/dogrucanemek-alt/conarium.git
cd conarium
npm install

# 2. Point it at your data (and write a policy — see Configuration)
export CONARIUM_DB_URL="postgresql://user:password@localhost:5432/mydb"

# 3. Run the governed MCP gateway
npm run dev          # or: npm run build && npm start
```

Conarium speaks MCP over **stdio**, so your AI assistant launches it as a command. Add this to your MCP client config (e.g. Cursor):

```json
{
  "mcpServers": {
    "conarium": { "command": "node", "args": ["dist/index.js"] }
  }
}
```

## ⚙️ Configuration (Policy as Code)

Control access using a simple `conarium.config.json` policy file:

```json
{
  "maxRows": 50,
  "allowTables": ["public.customers", "public.orders"],
  "denyTables": ["public.secrets", "public.financials"],
  "maskColumns": ["email", "ssn", "*.card", "*.api_key"]
}
```

Anything not in `allowTables` is denied by default; matched `maskColumns` are redacted to `[MASKED]` before the data ever reaches the model.

## 🗺️ Roadmap

Conarium is **early access** — and honest about what's real:

**Shipping now:** governed MCP gateway (stdio) · inline PII masking · allow/deny + row caps · immutable audit ledger · Postgres, docs & OpenAPI connectors.

**On the way:** one-command `npx conarium` CLI · hosted cloud console · SSO / RBAC · compliance reports (SOC2 / GDPR exports) · semantic (LLM-based) masking · Jira & Slack connectors.

## 📜 License

Conarium core is licensed under the [MIT License](LICENSE). Enterprise features and priority support will be available via [conarium.dev](https://conarium.dev).
