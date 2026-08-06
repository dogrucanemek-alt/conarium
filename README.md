<div align="center">
  <h1>Conarium</h1>
  <p><strong>The Third Eye for Your Company's Data.</strong></p>
  <p>A self-hosted, governed gateway that lets AI coding assistants (Cursor, Copilot, Claude) touch your real data—without exposing a single secret—and hands you a signed, independently verifiable receipt of every access.</p>
  
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
- **Verifiable Receipts (v0.1):** Ed25519-signed, independently verifiable receipts — see below.
- **Coverage & Reconciliation:** a signed coverage declaration over the receipt chain (`conarium-coverage`), plus two-sided reconciliation against the database's own query counters (`conarium-reconcile`) — DB-recorded activity that no receipt covers is surfaced instead of staying invisible.
- **100% Self-Hosted:** Runs entirely on your infrastructure. Your data never crosses your perimeter. 
- **MCP-Native:** Works out of the box with **Cursor**, **GitHub Copilot**, **Claude Code**, and **Windsurf**.

### Verifiable Receipts

Conarium can emit portable **receipts** (Art. 12 / 19 shaped) that a third party
verifies offline with a single file — no Conarium install required.

**Official claim (do not widen):** A Conarium Receipt proves that records have
**not been altered, deleted, reordered, or backdated after they were created**.
It does **not** prove they were correct at the moment of creation.

*(TR)* Conarium Makbuzu, kayıtların **oluşturulduktan sonra değiştirilmediğini,
silinmediğini, yeniden sıralanmadığını ve geriye dönük tarihlenmediğini**
kanıtlar. **Oluşturma anında doğru olduğunu kanıtlamaz.**

```bash
# Generate an Ed25519 keypair (private PEM + .pub.pem + .keyid sidecars)
node -e "import('./dist/keys.js').then(k=>console.log(JSON.stringify(k.writeKeyPairFiles('audit-ed25519','cnr-2026-07'),null,2)))"

export CONARIUM_AUDIT_SIGNING_KEY=./audit-ed25519.pem

# Verify a receipt chain (exit 0 = intact)
npx conarium-verify ./receipts.jsonl --pubkey ./audit-ed25519.pub.pem

# Optional: check OpenTimestamps sidecar (pending → exit 0 + warning; missing → 14)
npx conarium-verify ./receipts.jsonl --pubkey ./audit-ed25519.pub.pem --anchor-check
```

Opt-in anchoring: `CONARIUM_ANCHOR_SINK=opentimestamps`. Upgrade pending proofs later with
`npx conarium-anchor-upgrade ./audit.jsonl.anchors.jsonl`.

### Coverage & reconciliation (bypass detection)

Receipts prove what went **through** the gateway. Reconciliation asks the database
what it saw, and compares:

```bash
# One-sided: signed coverage declaration over a period + declared scope
npx conarium-coverage ./declaration.json --pubkey ./audit-ed25519.pub.pem --receipts ./receipts.jsonl

# Two-sided: reconcile the DB's own per-role query counters against receipts.
# Snapshots come from pg_stat_statements (scripts/pg-snapshot.sql), taken at
# window start and window end with a dedicated DB role per gateway instance.
npx conarium-reconcile --before before.json --after after.json --receipts ./receipts.jsonl
# exit 0  = every DB query pattern in the window is covered by receipts
# exit 40 = the DB recorded activity no receipt covers — the gateway may have
#           been bypassed, or the receipt sink failed
```

The language is deliberate: absence is reported as **"access NOT RECORDED"** /
**"not receipted"**, never "no access occurred" — an absent record is ambiguous
by nature, and a tool that pretends otherwise is lying to its auditor.

Full schema, exit codes, and known gaps: [`docs/RECEIPT-SPEC.md`](docs/RECEIPT-SPEC.md).

Signing is fail-closed: set `CONARIUM_AUDIT_SIGNING_KEY` and/or
`CONARIUM_AUDIT_HMAC_KEY`, or explicitly `CONARIUM_AUDIT_UNSIGNED=1` for throwaway setups.
Key rotation: keep prior public PEMs in `CONARIUM_AUDIT_TRUST_PUBKEYS` (`,` / `;`
separated). After the first signed audit line, every later line must carry `sig`.

### Where this sits among similar projects

Conarium is **not** the first project to produce signed, verifiable receipts for AI
activity. [Acta](https://github.com/VeritasActa/Acta),
[Emilia Protocol](https://github.com/emiliaprotocol/emilia-protocol),
[AuthProof](https://github.com/Commonguy25/authproof-sdk),
[Agent Receipts](https://github.com/agent-receipts) and
[Invariant SVR](https://github.com/Jasonleonardvolk/invariant-svr) all do a form of this,
and some are ahead of us on standardisation — Acta and Emilia both have IETF
Internet-Drafts. Related research: Aegon (arXiv 2604.06693), Decentralised Trust Layers
(ACM Web Conf 2026), and ISO/IEC TS 27560:2023 for signed consent records.

Those receipts attest to what an agent **did**. A Conarium receipt attests to what the
model was **prevented from seeing** — because the component that masks the data is the
same component that signs the record. Enforcement and evidence are one part here, not
two systems that have to be reconciled.

What we will defend: Conarium is the only implementation we are aware of that combines
all three of **(1) inline enforcement** (policy + masking), **(2) a portable,
offline-verifiable receipt** of that enforcement, and **(3) coverage
reconciliation** — checking the database's own query counters against the receipt
chain, so access that bypassed the gateway is surfaced instead of staying
invisible. Signing receipts without enforcing is common; enforcing without
portable receipts is common; reconciling both sides against the data source's
own bookkeeping is the part we have not found elsewhere. Measured end to end on
a real operating company's live ERP — 121,374 records, 121,366 identities
masked, 485,496 fields masked, zero leaked to the model
([Governance Report 001](https://conarium.dev/report-001.html)). If you know of
another, open an issue and this section will be corrected.

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

## 🚀 Quick Start

Conarium runs from source today. _(A one-command `npx conarium` CLI is on the [Roadmap](#️-roadmap).)_

```bash
# 1. Clone & install
git clone https://github.com/dogrucanemek-alt/conarium.git
cd nexus
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

Control access using a simple `conarium.json` policy file:

```json
{
  "maxRows": 50,
  "allowTables": ["public.customers", "public.orders"],
  "denyTables": ["public.secrets", "public.financials"],
  "maskColumns": ["email", "ssn", "*.card", "*.api_key"],
  "allowConnectors": ["postgres-main", "docs"]
}
```

Anything not in `allowTables` is denied by default; matched `maskColumns` are redacted to `[MASKED]` before the data ever reaches the model.

> **Connectors are fail-closed.** `allowConnectors` is a strict allow-list:
> if it is missing or empty, **no** connector is permitted (previously an empty
> list meant "allow all"). If you configure connectors, you must list them here —
> otherwise the server refuses to start and tells you exactly which field to add.
> `denyConnectors` still takes precedence over `allowConnectors`.

## 🗺️ Roadmap

Conarium is **early access** — and honest about what's real:

**Shipping now:** governed MCP gateway (stdio) · inline PII masking · allow/deny + row caps · immutable audit ledger · Postgres, docs & OpenAPI connectors.

**On the way:** one-command `npx conarium` CLI · hosted cloud console · SSO / RBAC · compliance reports (SOC2 / GDPR exports) · semantic (LLM-based) masking · Jira & Slack connectors.

## 📜 License

Conarium core is licensed under the [MIT License](LICENSE). Enterprise features and priority support will be available via [conarium.dev](https://conarium.dev).
