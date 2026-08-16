export interface ConariumConfig {
  connectors: ConnectorConfig[]
  serverName?: string
  serverVersion?: string
  /** Identity of the consumer (team / editor / user) for audit attribution. */
  consumer?: string
  /** Access policy enforced on every connector call. */
  policy?: GovernancePolicy
  /** Audit configuration. */
  audit?: AuditConfig
  /**
   * Proof profile. `production` requires Ed25519 AND HMAC, turns G3 strict
   * signatures and anchoring on, and defaults HTTP rate-limit to 60/min
   * unless CONARIUM_MCP_RATE_PER_MIN is explicitly 0.
   */
  profile?: 'production'
}

export interface GovernancePolicy {
  /** Allow-list of schema-qualified tables (glob: "billing.*", "*"). Missing or empty = deny all (default-deny). */
  allowTables?: string[]
  /** Deny-list of schema-qualified tables; takes precedence over allow. */
  denyTables?: string[]
  /** Columns to mask before data leaves the boundary ("customers.email", "*.tckn"). */
  maskColumns?: string[]
  /**
   * Columns whose values must not be learnable through predicates.
   * Same glob syntax as `maskColumns` (`"customers.email"`, `"*.tckn"`).
   *
   * Every pattern here is also treated as a `maskColumns` pattern: the value
   * is redacted in the result set. A column that cannot be queried but is
   * returned in the clear would be meaningless. You do not need to repeat
   * the pattern in `maskColumns`.
   *
   * A profile cannot set, clear, or replace this field. Protection is global.
   */
  protectedColumns?: string[]
  /** Hard cap on rows returned to the AI assistant (default 100). */
  maxRows?: number
  /**
   * Which SQL gate the shipped `query` tool uses. Operator declaration —
   * never inferred from the statement. Omitted = `postgres` (today's path)
   * except when a `custom-sql` connector is present: that path requires an
   * explicit dialect. Unknown values reject the config; they do not fall back.
   */
  dialect?: 'postgres' | 'mssql' | 'oracle'
  /**
   * Mask names that the text itself marks as names — a title ("Sn. Ahmet
   * Yılmaz") or a field label ("Yetkili: Ayşe Demir"). Default true.
   *
   * Names are the one identifier with no shape of their own, so column policy
   * was the only thing catching them and free text went through untouched.
   * This is NOT name recognition: a bare name in running prose is not detected,
   * because guessing would trade this gateway's deterministic decisions for a
   * confidence score. Set false where the labelled form is legitimate output —
   * typically via a profile, so it stays off for one identified person rather
   * than for everyone.
   */
  maskLabelledNames?: boolean
  /** Allowed API tools (e.g. "addPet", "getUser*"). */
  allowTools?: string[]
  /** Denied API tools. */
  denyTools?: string[]
  /** Allowed connector names (glob). Missing or empty = deny all (fail-closed). */
  allowConnectors?: string[]
  /** Denied connector names (glob); takes precedence over allow. */
  denyConnectors?: string[]
  /**
   * Named masking overlays, applied per person.
   *
   * The problem this solves: masking that is right for an AI agent is wrong for
   * the data controller. A shop owner asking "which customer owes the most" needs
   * the name; the assistant summarising revenue does not. A global on/off switch
   * would answer that by disabling the product's only real guarantee.
   *
   * Deliberately narrow: a profile may override `maskColumns`, `maxRows` and
   * `maskLabelledNames` — and NOTHING else. Table, tool and connector permissions
   * stay global, so a profile can never widen what is reachable — only what is
   * legible within it. `protectedColumns` is not overlayable: a per-person
   * profile that could drop a protection rule would be a back door.
   */
  profiles?: Record<string, MaskingProfile>
  /**
   * Actor id → profile name. Honoured ONLY for actors authenticated with a
   * per-user token (`assurance: 'per-user-token'`). A shared token never receives
   * a profile: "whoever holds this token sees unmasked PII" is exactly the
   * property this product exists to prevent.
   */
  actorProfiles?: Record<string, string>
  /**
   * Fail-closed scan length. A field longer than this is replaced whole with
   * `[MASKED_PII]` — it is never skipped. Default 16 384. Env
   * `CONARIUM_SCAN_CHAR_CAP` overrides. This is a usability knob: raising it
   * grows scan cost quadratically on the remaining detectors.
   */
  scanCharCap?: number
  /**
   * Optional content detectors. Identity detectors (TCKN, card, IBAN, email)
   * are not keys here and cannot be turned off — a config that tries is
   * rejected at load. `ip` defaults off (server IPs are not always personal
   * data). `mrz` defaults on (a passport MRZ is identity and checksummed).
   */
  detectors?: DetectorToggles
  /**
   * Extra content detectors the operator writes. Same scanner as the built-in
   * ones — not a second masking path. Each rule has a name (what the receipt
   * records), a pattern, optional column globs, and a mask label.
   *
   * A broken or ReDoS-shaped pattern rejects the config. The pattern text is
   * never written to logs or receipts.
   */
  customPatterns?: CustomPiiPattern[]
}

/** Operator-defined content detector. See `GovernancePolicy.customPatterns`. */
export interface CustomPiiPattern {
  /** Receipt `masking.byClass` key. Not the pattern. */
  name: string
  /** JS regex source. Compiled at load; never logged. */
  pattern: string
  /** Optional column globs (`*.hesap_no`). Empty / omitted = every scanned field. */
  columns?: string[]
  /** Replacement. Default `[MASKED_PII]`. Must be `[MASKED_…]`. */
  label?: string
  /**
   * Optional example the doctor tries against the compiled pattern.
   * Same sensitivity as `pattern` — never logged or printed.
   */
  sample?: string
}

/** See `GovernancePolicy.detectors`. */
export interface DetectorToggles {
  /** Opt-in. Default false. */
  ip?: boolean
  /** Passport TD3 MRZ. Default true. */
  mrz?: boolean
}

/** Per-person overlay. See `GovernancePolicy.profiles`. */
export interface MaskingProfile {
  maskColumns?: string[]
  maxRows?: number
  maskLabelledNames?: boolean
}

export interface AuditConfig {
  /** Append-only JSONL file path. If unset, audit goes to stderr only. */
  sink?: string
  failClosed?: boolean
  /** Optional: append-only JSONL file for verifiable access receipts. If unset, no receipts are produced. */
  receiptSink?: string
  /** Model identification for receipts (provider/name/version). */
  receiptModel?: { provider: string; name: string; version: string }
  /** Client identification for receipts (name/version). */
  receiptClient?: { name: string; version: string }
}

export interface ConnectorConfig {
  type: 'postgres' | 'supabase' | 'supabase-rest' | 'openapi' | 'files' | 'docs' | 'slack' | 'jira' | 'custom-sql'
  name: string
  description: string
  config: Record<string, string>
}

export interface SchemaTable {
  name: string
  schema: string
  columns: SchemaColumn[]
  rowCount?: number
  description?: string
}

export interface SchemaColumn {
  name: string
  type: string
  nullable: boolean
  isPrimary: boolean
  isForeign: boolean
  references?: string
  description?: string
}

export interface QueryResult {
  rows: Record<string, unknown>[]
  rowCount: number
  fields: string[]
  sql?: string
}

export interface ConnectorCapabilities {
  canQuery: boolean
  canListSchema: boolean
  canDescribeTable: boolean
  canSearch: boolean
}

export interface Connector {
  name: string
  description: string
  capabilities: ConnectorCapabilities
  connect(): Promise<void>
  disconnect(): Promise<void>
  listTables(): Promise<SchemaTable[]>
  describeTable(table: string): Promise<SchemaTable>
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  search(query: string, tables?: string[]): Promise<QueryResult>
}
