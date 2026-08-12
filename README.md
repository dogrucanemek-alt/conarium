<div align="center">
  <h1>Conarium</h1>
  <p><strong>The Third Eye for Your Company's Data.</strong></p>
  <p>A self-hosted, governed gateway that lets AI coding assistants (Cursor, Copilot, Claude) touch your real data—without exposing a single secret—and hands you a signed, independently verifiable receipt of every access.</p>
  
  <p>
    <a href="https://conarium.dev"><img src="https://img.shields.io/badge/Website-conarium.dev-5a8cff?style=for-the-badge" alt="Website" /></a>
    <a href="https://github.com/dogrucanemek-alt/conarium/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-f2d79a?style=for-the-badge" alt="License" /></a>
    <a href="https://github.com/dogrucanemek-alt/conarium/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-f2d79a?style=for-the-badge" alt="License" /></a>
    <img src="https://img.shields.io/badge/Status-Early%20Access-ff6f80?style=for-the-badge" alt="Early Access" />
  </p>
</div>

<br/>

The site lives at [conarium.dev](https://conarium.dev); this repository is the product.

## 👁️ The Problem

Point Cursor or Copilot at a production database and it drinks the raw stream—SSNs, credit cards, salaries, and live keys. One rogue prompt can expose your most sensitive tables. Security teams simply can't allow that.

## 🛡️ The Solution: Conarium

Conarium acts as a high-performance **MCP (Model Context Protocol) Proxy**. It sits directly between the AI Assistant and your databases, evaluating policies in milliseconds to enforce row limits and mask PII (Personally Identifiable Information) on the wire.

The AI gets the context it needs to write code, but never sees your secrets.

### Key Features

- **Inline PII Masking:** Emails, IDs, cards, and secrets are redacted in the response stream (`[MASKED]`) before the model sees a single character.
- **Allow / Deny Lists:** Whitelist what AI can access. Your `secrets` and `financials` tables stay invisible.
- **Row Caps:** Hard per-query limits. Prevent the silent exfiltration of millions of rows. 
- **Immutable Audit Ledger:** Every access is logged (who, what, when, rows, decision). Hash-chained and PII-safe — no raw PII ever written to the logs.
- **Verifiable Receipts (v0.1):** Ed25519-signed, independently verifiable receipts — see below.
- **Per-person masking profiles:** what to mask for an AI agent is not what to mask for the data controller. A named profile relaxes masking for one identified person, and the receipt records which profile applied — see below.
- **Coverage & Reconciliation:** a signed coverage declaration over the receipt chain (`conarium-coverage`), plus two-sided reconciliation against the database's own query counters (`conarium-reconcile`) — DB-recorded activity that no receipt covers is surfaced instead of staying invisible.
- **100% Self-Hosted:** Runs entirely on your infrastructure. Your data never crosses your perimeter. 
- **MCP-Native:** Works out of the box with **Cursor**, **GitHub Copilot**, **Claude Code**, and **Codex**.

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
# Generate an Ed25519 keypair (private PEM + .pub.pem + .keyid sidecars).
# The .keyid sidecars are not optional: without them the verifier answers 13
# for every receipt, which reads like tampering and is not.
npx conarium-init

export CONARIUM_AUDIT_SIGNING_KEY=./audit-ed25519.pem

# Verify a receipt chain (exit 0 = intact)
npx conarium-verify ./receipts.jsonl --pubkey ./audit-ed25519.pub.pem

# Optional: check OpenTimestamps sidecar (pending → exit 0 + warning; missing → 14)
npx conarium-verify ./receipts.jsonl --pubkey ./audit-ed25519.pub.pem --anchor-check
```

Opt-in anchoring: `CONARIUM_ANCHOR_SINK=opentimestamps`. Upgrade pending proofs later with
`npx conarium-anchor-upgrade ./audit.jsonl.anchors.jsonl`.

### Per-person masking profiles

Masking that is correct for an AI agent is wrong for the person who owns the data.
The owner asking *"which customer owes the most"* needs the name; the assistant
summarising revenue does not. Answering that with a global on/off switch would
disable the product's only real guarantee, so masking resolves **per person**:

```jsonc
{
  "policy": {
    "allowTables": ["zion.customers", "zion.orders"],
    "maskColumns": ["*.customer_name", "*.email", "*.phone"],  // default: everyone
    "maxRows": 100,

    "profiles": {
      // The controller sees customer names; email and phone stay masked.
      "controller-full": { "maskColumns": ["*.email", "*.phone"], "maxRows": 1000 }
    },
    "actorProfiles": { "emekcan": "controller-full" }
  }
}
```

Deliberately narrow, because this is the one feature that can *loosen* protection:

- A profile may override **`maskColumns`, `maxRows` and `maskLabelledNames` — and
  nothing else.** Table, tool and connector permissions stay global; a profile can
  never widen what is reachable, only what is legible within it.
- **Per-user tokens only.** An actor authenticated with a shared token never
  receives a profile. "Whoever holds this string sees unmasked PII" is precisely
  the failure this product exists to prevent.
- **Fail-closed everywhere else:** no actor, unlisted actor, or a profile name that
  does not exist all fall back to the base policy, never to a wider one.
- **The content scanners still run.** The email / national-ID / phone / card /
  secret detectors are not overridable at all, so those stay masked in free text
  no matter which profile applied. Name masking is the one detector a profile can
  switch off (`maskLabelledNames: false`), because the controller reading their
  own customer list is the case this feature exists for.
- **The receipt says which profile applied** — `policy.id` becomes
  `conarium.policy/<profile>`, inside the signed hash. An access made under a
  relaxed profile cannot later be presented as having been fully masked. This is
  what keeps the audit story honest: the point was never "nobody sees PII", it is
  "every access is governed, and the evidence says under which rules."

### Names in free text

Every other identifier has a shape. An email has an `@`, a national ID has a
checksum, a card has a length — a regex decides, and the decision reproduces.
A name has no shape, so `maskColumns` was the only thing catching one, and a name
typed into a free-text `note` reached the model verbatim.

Two deterministic passes close the part of that gap that can be closed honestly:

| Pass | What triggers it | Example |
|---|---|---|
| **Carry-over** | The value is one **this policy already masks** in some column | `customer_name` is masked, so `note: "Ayşe Demir called"` is masked too — including across rows |
| **Labelled** | The **text itself** marks it: a title or a field label | `Sn. Ahmet Yılmaz`, `Yetkili: Ayşe Demir`, `customer: John Smith` |

**What this does not do, deliberately: a bare name in running prose is not
detected.** "Ahmet called yesterday" goes through. Catching that needs NER — a
model, a dictionary and a confidence score — and every decision this gateway
makes is meant to be reproducible from the rule alone, by someone who does not
trust us. A probabilistic masker would also be a probabilistic *receipt*. Tools
that do run NER (Presidio-based ones, for instance) cover more entity types; they
buy that with a confidence threshold. Neither position dominates — this one is
stated so an auditor knows which one they are holding.

Carry-over ignores values under three characters (a two-character value matches
everywhere and would shred the output) and matches on Unicode word boundaries, so
`Ali` is masked in `Ali onayladı` but not inside `Kalite`.

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

Run against our own production ERP the day it shipped, including a real bypass we
performed on ourselves and the tool caught:
[`docs/dogfood/2026-08-06-reconcile.md`](docs/dogfood/2026-08-06-reconcile.md).

Full schema, exit codes, and known gaps: [`docs/RECEIPT-SPEC.md`](docs/RECEIPT-SPEC.md).

### Implementing the format yourself

The receipt is meant to outlive this implementation, so it ships with
conformance vectors — nine frozen cases plus a machine-readable manifest in
[`test-vectors/`](test-vectors/):

```bash
npm run test:vectors     # our verifier against the frozen cases
```

Point your own verifier at each `receipts.jsonl`, pass the arguments listed in
`manifest.json`, and compare the exit code. `expected-hashes.json` gives the
canonical JCS → SHA-256 hashes so you can check your canonicalisation without
needing our private key, which is deliberately not published.

The vectors found two things in this repository on their first run: a schema
check that reported a structurally invalid receipt as *tampered*, and a wrong
assumption of ours about unsigned receipts. Both are now frozen as cases 007
and 008.

### Anchoring your chain (optional)

`conarium-stamp` anchors a file to the OpenTimestamps calendars, and
`conarium-anchor-upgrade` fills in the Bitcoin block height once it lands.
Those two are all most setups need.

If you would rather expose anchoring as a small service — for several
gateways, or to hand an auditor a stable URL —
[`bin/conarium-anchor-service.mjs`](bin/conarium-anchor-service.mjs) is one:
it submits hashes, retains proofs, serves the raw `.ots` at a permanent path,
and upgrades pending anchors on a timer.

It is code you run, not a service we operate — there is no hosted instance to
sign up for. It also serves the raw proof precisely so a third party can verify
with the reference OpenTimestamps client and ignore the service entirely. An
anchoring endpoint you have to trust would defeat the purpose of anchoring.

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
([Governance Report 001](https://conarium.dev/report-001.html)).

That claim is hedged on purpose, and [`docs/PRIOR-ART.md`](docs/PRIOR-ART.md) is the
evidence behind it: ten projects checked on 6 August 2026, what each one has, the
closest academic prior art ([Sello / *Notarized Agents*](https://arxiv.org/html/2606.04193v1),
which names this gap better than we did), and nine things we could **not** verify. If
you know of an implementation combining all three, open an issue and it will be
corrected.

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

```bash
# 1. Install
npm i @conarium-ai/core

# 2. Write a fail-closed skeleton (config + Ed25519 pair + .keyid sidecars)
npx conarium-init
export CONARIUM_AUDIT_SIGNING_KEY="$PWD/audit-ed25519.pem"

# 3. Check the install before trusting it
npx conarium-doctor

# 4. Point the generated conarium.config.json at your read-only DSN,
#    fill policy.allowTables, then run the governed MCP gateway
npx conarium
```

Step 3 is not decoration. A missing config file does **not** stop the gateway —
it starts with zero connectors and governs nothing — and a connector that fails
to connect is logged, not raised. `conarium-doctor` names both, exits `1` when
something is wrong so it can gate a deployment, and never prints a secret, so
its output is safe to paste into an issue.

<details>
<summary>From source instead</summary>

```bash
git clone https://github.com/dogrucanemek-alt/conarium.git
cd conarium
npm install && npm run build
node bin/conarium-init.mjs
node bin/conarium-doctor.mjs --no-net
npm start
```

</details>

`conarium-init` refuses to overwrite existing files unless you pass `--force`.
It never prints the private key — only its path.

When the package is on npm, the same binaries will ship in the tarball
(`conarium-init`, `conarium-doctor`, `conarium-verify`). Until then, run them
from this repository as above.

### Before you file a bug: run the doctor

`conarium-doctor` checks the things that fail quietly. Two of them matter most:
a **missing config file does not stop the gateway** — it starts with zero
connectors and governs nothing — and a **connector that cannot connect is logged,
not raised**, so the process looks healthy while serving nothing. The doctor also
catches the missing `<pubkey>.keyid` sidecar, which makes every receipt verify as
`13` (reads like tampering, isn't).

It exits `0` when clean and `1` when something is wrong, so it can gate a
deployment. **It never prints a secret** — passwords, tokens and key material are
reported as shape only (`postgresql://appuser@db.internal:5432/prod (password
set, not shown)`), which means the output is safe to paste into an issue or an
email.

Conarium speaks MCP over **stdio**, so your AI assistant launches it as a command. Add this to your MCP client config (e.g. Cursor):

```json
{
  "mcpServers": {
    "conarium": {
      "command": "npx",
      "args": ["-y", "--package=@conarium-ai/core", "conarium", "--config", "/path/to/your/conarium.config.json"]
    }
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

**Shipping now:** governed MCP gateway (stdio + HTTP) · deterministic PII masking,
including labelled names in free text · allow/deny + row caps · per-person masking
profiles · immutable hash-chained audit ledger · Ed25519-signed receipt per access
with an offline verifier · signed coverage declarations · two-sided reconciliation
against the database's own counters · OpenTimestamps anchoring and an optional
anchoring service · conformance vectors · Postgres, Supabase, docs, OpenAPI, Jira
and Slack connectors · `conarium-init` / `conarium-doctor` from source (npm
publish is the remaining step before `npx` works).

**Next:** consent binding ([spec published](docs/CONSENT-BINDING-SPEC.md), no code —
patent review first) · a second independent implementation of the receipt format ·
per-user identity bound to an identity provider rather than an operator token map ·
publishing `@conarium-ai/core` to npm so `npx conarium-init` works without a clone.

**Deliberately not planned**, so nobody waits for it:

- **LLM-based "semantic" masking.** The gate is deterministic on purpose. A
  probabilistic mask would make a probabilistic receipt, which is not a receipt.
- **Hosted cloud console.** Self-hosted is the claim; a hosted console would put
  us in the data path we tell you we are not in.
- **SOC 2.** It audits organisations that hold customer data. We never receive
  yours. If that ever stops being true, this line changes first.

Known gaps are listed in the README above and in
[`docs/RECEIPT-SPEC.md`](docs/RECEIPT-SPEC.md) rather than hidden here.

## 📜 License

MIT — all of it, including the verifier, the reconciliation tooling and the
anchoring service. There is no feature held back for a paid tier; what
[conarium.dev](https://conarium.dev) sells is support, not access to code.
