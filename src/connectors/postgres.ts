import postgres from 'postgres';
import { parse } from 'pgsql-ast-parser';
import { Connector, ConnectorCapabilities, ConnectorConfig, QueryResult, SchemaTable } from '../types.js';

type SafePostgresParam = string | number | boolean | Date | Uint8Array | null;

const WRITE_TOKENS = /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|ALTER|CREATE|GRANT|REVOKE|MERGE|COPY|CALL|DO|VACUUM)\b/i;

function assertReadOnlySql(query: string): void {
  const norm = query.trim();
  if (!/^(SELECT|WITH)\b/i.test(norm)) {
    throw new Error('PostgresConnector only permits read-only SELECT/WITH queries.');
  }
  if (WRITE_TOKENS.test(norm)) {
    throw new Error('PostgresConnector blocked a write operation token.');
  }
  const ast = parse(query);
  if (ast.length !== 1 || !['select', 'with', 'with recursive'].includes(ast[0].type)) {
    throw new Error('PostgresConnector only permits a single read-only statement.');
  }
}

function normalizeParams(params?: unknown[]): SafePostgresParam[] | undefined {
  if (!params) return undefined;
  return params.map(param => {
    if (
      param === null ||
      typeof param === 'string' ||
      typeof param === 'number' ||
      typeof param === 'boolean' ||
      param instanceof Date ||
      param instanceof Uint8Array
    ) {
      return param;
    }
    throw new Error(`Unsupported Postgres query parameter type: ${typeof param}`);
  });
}

export class PostgresConnector implements Connector {
  name: string;
  description: string;
  capabilities: ConnectorCapabilities;
  private sql?: postgres.Sql<{}>;
  private connectionString: string;
  private mockMode: boolean;

  constructor(config: ConnectorConfig) {
    this.name = config.name;
    this.description = 'PostgreSQL Connector';
    // Use env or config. Never embed secrets in code.
    this.connectionString = config.config?.url || process.env.ZION_READONLY_DSN || process.env.DATABASE_URL || '';
    this.mockMode = config.config?.mock === 'true';
    
    this.capabilities = {
      canQuery: true,
      canListSchema: true,
      canDescribeTable: true,
      canSearch: false
    };
  }

  async connect(): Promise<void> {
    if (this.mockMode) return;
    if (!this.connectionString) {
      throw new Error('DATABASE_URL or config.url is required for PostgresConnector');
    }
    this.sql = postgres(this.connectionString);
  }

  async disconnect(): Promise<void> {
    if (this.sql) {
      await this.sql.end();
    }
  }

  async listTables(): Promise<SchemaTable[]> {
    if (this.mockMode) return [{ name: 'users', schema: 'public', columns: [] }];
    if (!this.sql) throw new Error('Not connected');
    
    const rows = await this.sql`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
    `;
    
    return rows.map(r => ({
      name: r.table_name,
      schema: r.table_schema,
      columns: []
    }));
  }

  async describeTable(table: string): Promise<SchemaTable> {
    if (this.mockMode) return { name: table, schema: 'public', columns: [] };
    if (!this.sql) throw new Error('Not connected');

    const parts = table.split('.');
    const schema = parts.length > 1 ? parts[0] : 'public';
    const tableName = parts.length > 1 ? parts[1] : parts[0];

    const rows = await this.sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = ${tableName}
    `;

    return {
      name: tableName,
      schema,
      columns: rows.map(r => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === 'YES',
        isPrimary: false,
        isForeign: false
      }))
    };
  }

  async query(query: string, params?: unknown[]): Promise<QueryResult> {
    assertReadOnlySql(query);

    if (this.mockMode) {
      return {
        rows: [{ id: 1, email: 'test@example.com', name: 'Mock User' }],
        rowCount: 1,
        fields: ['id', 'email', 'name'],
        sql: query
      };
    }

    if (!this.sql) throw new Error('Not connected');

    const queryParams = normalizeParams(params);
    const rows = queryParams ? await this.sql.unsafe(query, queryParams) : await this.sql.unsafe(query);
    
    return {
      rows: Array.from(rows),
      rowCount: rows.length,
      fields: rows.columns ? rows.columns.map(c => c.name) : [],
      sql: query
    };
  }

  async search(query: string, tables?: string[]): Promise<QueryResult> {
    throw new Error('Not supported natively, use query()');
  }
}
