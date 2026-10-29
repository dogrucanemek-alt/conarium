# API stability (draft)

This is an inventory, not a 1.0 release. Version is 0.2.x. Anything
unmarked below can still break.

**Labels**

| Label | Meaning at 0.2.x |
|---|---|
| **candidate** | Would be promised at 1.0: break only on a major version, announced in CHANGELOG. |
| **experimental** | Useful now. Shape can change on a minor. |
| **internal** | Not an API. Importing it or depending on it is unsupported. |

No dates. Shipping 1.0 is a decision, not a document.

---

## What 1.0 would promise

- A receipt written as `conarium-receipt/0.4` (or `0.3`, `0.2`, `0.1`) still
  verifies with `conarium-verify` after a 1.x upgrade. Older published `v`
  strings stay accepted.
- Default-deny: missing or empty `policy.allowTables` permits no table.
  A deny list wins over an allow list.
- The four MCP tools keep their names: `list_tables`, `describe_table`,
  `query`, `search`. Required argument names (`table`, `sql`, `query`)
  stay.
- `conarium-verify` exit codes in `docs/RECEIPT-SPEC.md` stay.

## What 1.0 would not promise

- A JavaScript import surface. The package root (`main`, and `"."` in the
  `exports` map) is the stdio gateway and runs it on import. The one library
  entry, `@conarium-ai/core/mask`, is experimental (see Package exports).
  `import { Governance } from '@conarium-ai/core'` is not an API.
- MySQL. The SQL gate is Postgres, Microsoft SQL Server, and Oracle. Oracle synonyms and database links are not resolved.
- That an OpenTimestamps stamp is confirmed. `pending` is a valid
  outcome.
- Console UI layout, playground sample data, or `/api/connectors`
  fixture rows.
- That a free-text name is masked. See LIMITATIONS.
- Performance numbers. See `docs/BENCHMARK.md`.
- Connector types other than `postgres` / `docs` remaining in the
  config enum without change.

## How a breaking change would be announced

1. CHANGELOG, under a major version, names the old shape and the new
   one.
2. Receipt schema: a new `v` string. Old strings stay verifiable.
   Fields are not renamed in place.
3. MCP / CLI: the old name is rejected with a named error, not a
   silent fallback.
4. Config: unknown keys already fail at load (`.strict()`). A removed
   key fails the same way. A changed default that widens access is a
   break even if the key name is unchanged.

---

## CLI (`package.json` `bin`)

| Command | Flags / args | Label |
|---|---|---|
| `conarium` | `--config <path>` (default `conarium.config.json`) | experimental — stdio MCP entry |
| `conarium-init` | `--out` `--force` `--no-keys` `--help` | experimental |
| `conarium-doctor` | `--config` `--no-net` `--help` | experimental |
| `conarium-verify` | `--pubkey` (repeatable) `--anchor-check` `--require-head-anchor` `--anchors` `--expect-seq-from` `--expect-count` `--expect-last-hash` `--strict` `--json` `--help` | **candidate** (exit codes + flags in RECEIPT-SPEC) |
| `conarium-coverage` | `--pubkey` `--receipts` `--expect-seq-from` `--allow-gaps` `--json` `--help` | experimental |
| `conarium-reconcile` | `--before` `--after` `--receipts` `--skew` `--profile` `--json` `--json-v2` `--result-v2` `--help` | experimental |
| `conarium-stamp` | `--sidecar` `--json` `--help` | experimental |
| `conarium-anchor-upgrade` | `<anchors.jsonl>` | experimental |
| `conarium-console` | `--config` `--port` `--host` `--install-shortcut` `--uninstall-shortcut` `--launch` `--help` | experimental |
| `conarium-suggest-policy` | `--sql` `--json` `--help` | experimental |

`bin/conarium-anchor-service.mjs` is **not** in `bin`. **internal.**

---

## Config (`conarium.config.json`)

Parsed by `src/config.ts` (Zod `.strict()`). Unknown keys reject the file.

| Field | Label |
|---|---|
| `connectors[]` (`type`, `name`, `description`, `config`) | experimental |
| `connectors[].type` enum (`postgres`, `supabase`, `supabase-rest`, `openapi`, `files`, `docs`, `slack`, `jira`, `custom-sql`) | experimental — values can be added or removed |
| `serverName` `serverVersion` `consumer` | experimental |
| `policy.allowTables` `denyTables` | **candidate** (default-deny, deny wins) |
| `policy.maskColumns` `maxRows` | experimental (cap ceiling is 10 000 at parse) |
| `policy.dialect` (`postgres` omitted default, `mssql`, `oracle`) | experimental — unknown values reject the file; not inferred from SQL; required when a `custom-sql` connector is present |
| `policy.allowConnectors` `denyConnectors` | experimental — empty allow is fail-closed |
| `policy.allowTools` `denyTools` | experimental |
| `policy.profiles` `actorProfiles` | experimental |
| `policy.maskLabelledNames` `scanCharCap` `detectors` `customPatterns` | experimental |
| `audit.sink` `failClosed` `receiptSink` | experimental |
| `audit.receiptModel` `audit.receiptClient` | experimental (`source: operator-declared`) |

Identity detectors cannot be turned off from config. That rejection is
**candidate** behaviour.

---

## Receipt JSON

Canonical: `docs/RECEIPT-SPEC.md`. Schema string `conarium-receipt/0.4`.
Verifier accepts `0.1`–`0.4`. A `0.3` receipt is not rewritten.

| Piece | Label |
|---|---|
| Media type `application/vnd.conarium.receipt+json` | **candidate** |
| Required fields listed in RECEIPT-SPEC (`ts`, `chain`, `sig`, …) | **candidate** |
| `consentRef` always `null` in 0.4 (and 0.1–0.3) | **candidate** (field stays; value may change in a later `v`) |
| `anchor` may be `null` / `pending` | **candidate** |
| Hash / Ed25519 construction | **candidate** |
| Adding optional fields in a new `v` | allowed |
| Renaming or removing a field inside `0.4` | break |

---

## MCP tools

| Tool | Params | Label |
|---|---|---|
| `list_tables` | `connector?` | **candidate** name; params experimental |
| `describe_table` | `table` (required), `connector?` | **candidate** name; `table` required |
| `query` | `sql` (required), `connector?` | **candidate** name; `sql` required |
| `search` | `query` (required), `tables?`, `connector?` | **candidate** name; `query` required |

Tool presence can still be filtered by `policy.allowTools` /
`denyTools`. That filter is experimental.

HTTP MCP (not a `bin` name): `CONARIUM_MCP_TOKEN` (required, ≥24),
`CONARIUM_MCP_HOST`, `CONARIUM_MCP_PORT`, `CONARIUM_MCP_RATE_PER_MIN`.
**experimental.**

---

## Console HTTP

Loopback operator UI (`conarium-console`). Not a public API.

| Route | Label |
|---|---|
| `GET /handoff?n=` | experimental |
| `GET /api/presence` | experimental |
| `GET /api/receipts` | experimental |
| `GET /api/receipts/:id` | experimental |
| `GET /api/receipts/:id/raw` | experimental |
| `GET /api/receipts/:id/html` | experimental |
| `GET /api/config` `POST /api/config` | experimental |
| `GET /api/audit` | experimental |
| `POST /api/playground` | experimental — in-memory sample rows |
| `GET /api/connectors` | **internal** — fixture JSON, not live connectors |
| static `/` and `/assets` | internal |

Env: `CONARIUM_CONSOLE_HOST`, `CONARIUM_CONSOLE_PORT`,
`CONARIUM_CONSOLE_RATE_PER_MIN`. experimental.

---

## Package exports

| Entry | Label |
|---|---|
| `bin` map above | see CLI |
| `"main": "./dist/index.js"`, `exports["."]` | experimental — process entry, not a library; importing it starts the stdio gateway |
| `exports["./mask"]` → `./dist/mask.js` | experimental — `maskField`, `maskSensitiveText`, `compileCustomPatterns` and their types; importing it starts no server (`test/mask_entry.mjs`) |
| `maskField` options `only`, results `classes` and `masked` | experimental — `only` lists the classes to mask; `classes` counts what the core found per class, `masked` what was replaced (`unclassified`, or `{ whole: 1 }`); counts, never values (`src/mask-classes.test.ts`) |
| `maskField` option `pipeline: 'speech'` | experimental — text a local speech model wrote from a recording; digit runs of 7 or more digits split by spaces or hyphens, spoken `et` / `at` and `nokta` addresses and four or more dotted labels whose first two are letters only, with a word in the fixed list `DOMAIN_ENDINGS` in `src/mask/speech.ts` (a dotted run's last label; a spoken address is read up to its last listed word, so `example nokta dev nokta jp` leaves `nokta jp`; an address that mixes written dots and spoken `nokta` on either side of `et` / `at` (`ayşe.yılmaz et example nokta com`, `ayşe nokta yılmaz et example.com`, `ayşe.yılmaz et example.com`) is one `email` span; an ending written with a Turkish capital İ is read — for the ending lookup only, the word is lowercased, U+0307 is dropped and `ı` is read as `i`; `biz` is not in the list; an address with no listed word is not masked by these rules), and `TR` plus at least four such digits as an IBAN. Classes come from the text pipeline's core detectors first, as in 0.3.3, so a Luhn-valid card written in phone-shaped groups (`4111-11-111-111-1111`) counts as `phone`, and an 11-digit run that fails the TCKN checksum counts as `tckn`; when the core and the speech rules name different classes for one number (`1-000-000-0146`: `phone` and `tckn`), both are counted and it is masked if either class is asked for. An amount with thousands separators (`1.250.000`, `1.250,00`) or under 7 digits before its decimal comma stays; `1234567,89` is a run of 7 digits and is masked, and so is a decimal part of 7 or more digits (`0,1234567`). The same digits with spaces (`1 250 000`) are a run. The text pipeline is unchanged. |
| package `@conarium-ai/mask` (`packages/mask`) | experimental — the same `src/mask.ts`, built on its own with `@eslint-community/regexpp` and `re2js` as its only dependencies (`test/mask_package.mjs`) |
| `exports["./*"]` → `./*` | a deep path that names a file, extension included, resolves to that file; extensionless `require` paths, which resolved before the map existed, no longer do. What it reaches is **internal** |
| `dist/governance.js`, `dist/ots/*`, `dist/http.js`, … | **internal** |
| TypeScript types in `src/types.ts` | **internal**, except the ones `./mask` re-exports |

---

## 1.0 is not this file

This inventory is input. It does not ship a version, set a date, or
freeze the tree.
