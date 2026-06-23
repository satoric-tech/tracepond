import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import ms from "ms";

export type QueryResult = {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  elapsedMs: number;
};

const defaultRefreshIntervalMs = 5 * 60 * 1000;

export type MemoryConfig = {
  cwd: string;
  codexHome: string;
  claudeHome: string;
  cursorHome: string;
  opencodeDataDirs: string[];
  databasePath: string;
  client: string;
  refreshIntervalMs: number;
};

type TraceSource = "codex" | "claude" | "cursor" | "opencode";

export class MemoryDuckDb {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;

  static async open(config: Partial<MemoryConfig> = {}): Promise<MemoryDuckDb> {
    const db = new MemoryDuckDb(resolveMemoryConfig(config));
    await db.initialize();
    return db;
  }

  private constructor(private readonly config: MemoryConfig) {}

  async close(): Promise<void> {
    this.connection?.closeSync();
    this.connection = null;
    this.instance?.closeSync();
    this.instance = null;
  }

  async query(sql: string): Promise<QueryResult> {
    assertSafeReadOnlySql(sql);
    const connection = this.requireConnection();
    const started = performance.now();
    const reader = await connection.runAndReadAll(sql);
    const rows = reader.getRowsJson() as unknown[][];
    return {
      columns: reader.columnNames(),
      rows,
      rowCount: rows.length,
      elapsedMs: performance.now() - started,
    };
  }

  async describe(): Promise<string> {
    const result = await this.query(`
      SELECT table_name, column_name, data_type AS column_type
      FROM duckdb_columns()
      WHERE schema_name = 'main'
        AND table_name IN ('source_files', 'tracepond_metadata', 'codex_raw', 'codex_events', 'claude_raw', 'claude_events', 'cursor_raw', 'cursor_events', 'opencode_raw', 'opencode_events', 'messages', 'conversations', 'tool_calls')
      ORDER BY table_name, column_index
    `);

    return [
      "tracepond exposes read-only DuckDB SQL over local coding-agent traces.",
      "",
      "Resolved config:",
      `- client: ${this.config.client}`,
      `- cwd: ${this.config.cwd}`,
      `- database_path: ${this.config.databasePath}`,
      `- refresh_interval_ms: ${this.config.refreshIntervalMs}`,
      `- codex_home: ${this.config.codexHome}`,
      `- claude_home: ${this.config.claudeHome}`,
      `- cursor_home: ${this.config.cursorHome}`,
      `- opencode_data_dirs: ${this.config.opencodeDataDirs.join(", ") || "(none)"}`,
      "",
      "Storage policy:",
      "- bronze: views over raw source files/stores",
      "- silver: views over bronze",
      "- gold: materialized tables",
      "- search: DuckDB FTS indexes on gold tables",
      "",
      "Core tables/views:",
      "- codex_raw: raw Codex JSONL rows read from <codex_home>/sessions/**/*.jsonl",
      "- codex_events: extracted Codex event fields plus raw JSON",
      "- claude_raw: raw Claude Code JSONL rows read from <claude_home>/projects/**/*.jsonl and <claude_home>/history.jsonl",
      "- claude_events: extracted Claude event fields plus raw JSON",
      "- cursor_raw: raw Cursor SQLite rows read from <cursor_home>/chats/*/*/store.db",
      "- cursor_events: extracted Cursor message/tool fields from decoded blob JSON",
      "- opencode_raw: raw OpenCode JSON rows read from <opencode_data_dir>/storage/session/**/*.json and <opencode_data_dir>/storage/message/**/*.json",
      "- opencode_events: extracted OpenCode event/session fields plus raw JSON",
      "- messages: materialized cross-source normalized message stream with FTS on text",
      "- conversations: materialized cross-source conversation/session rollups with FTS on first_user_text and last_text",
      "- tool_calls: materialized cross-source normalized tool calls and results with FTS on input_text and output_text",
      "- source_files: manifest of discovered source files, mtimes, sizes, and ingest timestamps",
      "- tracepond_metadata: refresh metadata and internal cache state",
      "",
      "User queries run against a DuckDB database reopened with access_mode=READ_ONLY.",
      "",
      "`line_number` is the JSONL row number within the scanned file.",
      "",
      "Schema:",
      formatQueryResult(result),
      "",
      "Example queries:",
      "SELECT event_type, payload_type, count(*) FROM codex_events GROUP BY 1, 2 ORDER BY 3 DESC;",
      "SELECT source, ts, role, substr(text, 1, 120) FROM messages WHERE text ILIKE '%deploy%' ORDER BY ts DESC LIMIT 10;",
      "SELECT source, session_id, message_count, substr(first_user_text, 1, 120) FROM conversations ORDER BY ended_at DESC NULLS LAST LIMIT 10;",
      "SELECT ts, filename, line_number, text FROM codex_events WHERE text ILIKE '%corpus_mente%' ORDER BY ts LIMIT 20;",
      "SELECT tool_name, count(*) FROM codex_events WHERE payload_type = 'function_call' GROUP BY 1 ORDER BY 2 DESC;",
      "SELECT session_id, role, substr(text, 1, 120) FROM cursor_events WHERE text ILIKE '%deploy%' LIMIT 10;",
      "SELECT source, ts, role, substr(text, 1, 120), fts_main_messages.match_bm25(message_key, 'deploy') AS score FROM messages WHERE score IS NOT NULL ORDER BY score DESC LIMIT 10;",
    ].join("\n");
  }

  private async initialize(): Promise<void> {
    await mkdir(path.dirname(this.config.databasePath), { recursive: true });

    this.instance = await DuckDBInstance.create(this.config.databasePath, writableDuckDbOptions());
    this.connection = await this.instance.connect();
    await this.bootstrapSchema();
    await this.bootstrapViews();
    const shouldRunGlobalTableRefresh = await this.shouldRunGlobalTableRefresh();
    const missingGoldTables = await this.missingGoldTables();
    if (missingGoldTables || this.config.refreshIntervalMs <= 0) {
      await this.refreshGoldTables();
      await this.markGlobalTableRefresh();
    } else if (shouldRunGlobalTableRefresh) {
      this.refreshGoldTablesInBackground();
    }

    this.connection.closeSync();
    this.connection = null;
    this.instance.closeSync();
    this.instance = null;

    this.instance = await DuckDBInstance.create(this.config.databasePath, readOnlyDuckDbOptions());
    this.connection = await this.instance.connect();
    await this.loadSqliteExtension();
    await this.loadFtsExtension();
  }

  private async bootstrapSchema(): Promise<void> {
    const connection = this.requireConnection();

    await connection.runAndReadAll(`
      CREATE TABLE IF NOT EXISTS source_files (
        source VARCHAR,
        path VARCHAR PRIMARY KEY,
        size_bytes BIGINT,
        mtime_ms BIGINT,
        ingested_at TIMESTAMP
      )
    `);

    await connection.runAndReadAll(`
      CREATE TABLE IF NOT EXISTS tracepond_metadata (
        key VARCHAR PRIMARY KEY,
        value VARCHAR
      )
    `);

    await connection.runAndReadAll(`
      CREATE INDEX IF NOT EXISTS source_files_path_idx ON source_files(path)
    `);
  }

  private async refreshMaterializedTables(): Promise<void> {
    await this.bootstrapViews();
    await this.refreshGoldTables();
  }

  private async refreshGoldTables(): Promise<void> {
    const connection = this.requireConnection();
    await this.dropRelation("messages");
    await connection.runAndReadAll(`CREATE TABLE messages AS ${this.messagesSelectSql()}`);

    await this.dropRelation("conversations");
    await connection.runAndReadAll(`CREATE TABLE conversations AS ${this.conversationsSelectSql()}`);

    await this.dropRelation("tool_calls");
    await connection.runAndReadAll(`CREATE TABLE tool_calls AS ${this.toolCallsSelectSql()}`);

    await this.dropRelation("search_documents");
    await this.createGoldSearchIndexes();
  }

  private async shouldRunGlobalTableRefresh(): Promise<boolean> {
    if (this.config.refreshIntervalMs <= 0) {
      return true;
    }
    const reader = await this.requireConnection().runAndReadAll(`
      SELECT value
      FROM tracepond_metadata
      WHERE key = 'last_global_refresh_at'
    `);
    const rows = reader.getRowsJson() as unknown[][];
    const lastRefresh = rows[0]?.[0];
    if (!lastRefresh) {
      return true;
    }
    const lastRefreshMs = new Date(String(lastRefresh)).getTime();
    return !Number.isFinite(lastRefreshMs) || Date.now() - lastRefreshMs >= this.config.refreshIntervalMs;
  }

  private async missingGoldTables(): Promise<boolean> {
    return !(await this.tableExists("messages")) ||
      !(await this.tableExists("conversations")) ||
      !(await this.tableExists("tool_calls"));
  }

  private refreshGoldTablesInBackground(): void {
    const config = { ...this.config, refreshIntervalMs: 0 };
    setImmediate(() => {
      MemoryDuckDb.open(config)
        .then((db) => db.close())
        .catch(() => {
          // Background refresh is best-effort; foreground queries keep using the last gold cache.
        });
    });
  }

  private async tableExists(tableName: string): Promise<boolean> {
    const reader = await this.requireConnection().runAndReadAll(`
      SELECT count(*) AS n
      FROM duckdb_tables()
      WHERE schema_name = 'main'
        AND table_name = ${sqlString(tableName)}
    `);
    const rows = reader.getRowsJson() as unknown[][];
    return BigInt(rows[0]?.[0] as bigint | number | string) > 0n;
  }

  private async viewExists(viewName: string): Promise<boolean> {
    const reader = await this.requireConnection().runAndReadAll(`
      SELECT count(*) AS n
      FROM duckdb_views()
      WHERE schema_name = 'main'
        AND view_name = ${sqlString(viewName)}
    `);
    const rows = reader.getRowsJson() as unknown[][];
    return BigInt(rows[0]?.[0] as bigint | number | string) > 0n;
  }

  private async dropRelation(name: string): Promise<void> {
    const connection = this.requireConnection();
    if (await this.viewExists(name)) {
      await connection.runAndReadAll(`DROP VIEW ${name}`);
    }
    if (await this.tableExists(name)) {
      await connection.runAndReadAll(`DROP TABLE ${name}`);
    }
  }

  private async markGlobalTableRefresh(): Promise<void> {
    await this.requireConnection().runAndReadAll(`
      INSERT OR REPLACE INTO tracepond_metadata
      VALUES ('last_global_refresh_at', ${sqlString(new Date().toISOString())})
    `);
  }

  private async upsertSourceFiles(files: Array<{
    source: TraceSource;
    path: string;
    sizeBytes: number;
    mtimeMs: number;
  }>): Promise<void> {
    const connection = this.requireConnection();
    for (let index = 0; index < files.length; index += 500) {
      const chunk = files.slice(index, index + 500);
      if (chunk.length === 0) {
        continue;
      }
      const values = chunk.map((file) => `(
        ${sqlString(file.source)},
        ${sqlString(file.path)},
        ${file.sizeBytes},
        ${file.mtimeMs},
        now()
      )`).join(",\n");
      await connection.runAndReadAll(`
        INSERT OR REPLACE INTO source_files
        VALUES ${values}
      `);
    }
  }

  private async loadSqliteExtension(): Promise<void> {
    try {
      await this.requireConnection().runAndReadAll("LOAD sqlite;");
    } catch {
      await this.requireConnection().runAndReadAll("INSTALL sqlite; LOAD sqlite;");
    }
  }

  private async loadFtsExtension(): Promise<void> {
    try {
      await this.requireConnection().runAndReadAll("LOAD fts;");
    } catch {
      await this.requireConnection().runAndReadAll("INSTALL fts; LOAD fts;");
    }
  }

  private async bootstrapViews(): Promise<void> {
    const connection = this.requireConnection();
    await this.bootstrapBronzeViews();

    await connection.runAndReadAll(`
      CREATE OR REPLACE VIEW codex_events AS
      SELECT
        source,
        filename,
        line_number,
        json_extract_string(raw, '$.timestamp')::TIMESTAMP AS ts,
        json_extract_string(raw, '$.type') AS event_type,
        json_extract_string(raw, '$.payload.type') AS payload_type,
        json_extract_string(raw, '$.payload.metadata.turn_id') AS turn_id,
        json_extract_string(raw, '$.payload.role') AS role,
        json_extract_string(raw, '$.payload.name') AS tool_name,
        json_extract_string(raw, '$.payload.call_id') AS call_id,
        coalesce(
          json_extract_string(raw, '$.payload.message'),
          json_extract_string(raw, '$.payload.content[0].text'),
          json_extract_string(raw, '$.payload.arguments'),
          json_extract_string(raw, '$.payload.output')
        ) AS text,
        raw
      FROM codex_raw
    `);

    await connection.runAndReadAll(`
      CREATE OR REPLACE VIEW claude_events AS
      SELECT
        source,
        filename,
        line_number,
        json_extract_string(raw, '$.timestamp')::TIMESTAMP AS ts,
        json_extract_string(raw, '$.type') AS event_type,
        json_extract_string(raw, '$.subtype') AS subtype,
        json_extract_string(raw, '$.session_id') AS session_id,
        json_extract_string(raw, '$.message.role') AS role,
        json_extract_string(raw, '$.message.content[0].type') AS content_type,
        json_extract_string(raw, '$.message.content[0].name') AS tool_name,
        coalesce(
          json_extract_string(raw, '$.content'),
          json_extract_string(raw, '$.result'),
          json_extract_string(raw, '$.message.content[0].text'),
          json_extract_string(raw, '$.message.content[0].content'),
          json_extract_string(raw, '$.tool_use_result.stdout'),
          json_extract_string(raw, '$.tool_use_result.stderr')
        ) AS text,
        raw
      FROM claude_raw
    `);

    await connection.runAndReadAll(`
      CREATE OR REPLACE VIEW cursor_events AS
      WITH decoded AS (
        SELECT
          source,
          filename,
          row_number,
          key AS blob_id,
          try(decode(value_blob)) AS raw_text
        FROM cursor_raw
        WHERE store_table = 'blobs'
      ),
      parsed AS (
        SELECT
          source,
          filename,
          row_number,
          blob_id,
          raw_text::JSON AS raw
        FROM decoded
        WHERE raw_text IS NOT NULL
          AND json_valid(raw_text)
          AND json_extract_string(raw_text::JSON, '$.role') IS NOT NULL
      )
      SELECT
        source,
        filename,
        row_number,
        regexp_extract(filename, '/chats/([^/]+)/([^/]+)/store\\.db$', 1) AS workspace_id,
        regexp_extract(filename, '/chats/([^/]+)/([^/]+)/store\\.db$', 2) AS session_id,
        blob_id,
        NULL::TIMESTAMP AS ts,
        json_extract_string(raw, '$.role') AS role,
        json_extract_string(raw, '$.id') AS message_id,
        coalesce(
          json_extract_string(raw, '$.content[0].toolName'),
          json_extract_string(raw, '$.content[0].toolCallId'),
          json_extract_string(raw, '$.content[0].type')
        ) AS content_type,
        coalesce(
          json_extract_string(raw, '$.content[0].toolName'),
          json_extract_string(raw, '$.content[0].toolCallId')
        ) AS tool_name,
        coalesce(
          json_extract_string(raw, '$.content[0].toolCallId'),
          json_extract_string(raw, '$.content[0].tool-call.toolCallId'),
          json_extract_string(raw, '$.toolCallId')
        ) AS tool_call_id,
        coalesce(
          json_extract_string(raw, '$.content[0].text'),
          json_extract_string(raw, '$.content[0].result'),
          CASE WHEN json_type(raw, '$.content') = 'VARCHAR'
            THEN json_extract_string(raw, '$.content')
          END
        ) AS text,
        raw
      FROM parsed
    `);

    await connection.runAndReadAll(`
      CREATE OR REPLACE VIEW opencode_events AS
      SELECT
        source,
        filename,
        kind,
        session_id,
        line_number,
        coalesce(
          json_extract_string(raw, '$.created'),
          json_extract_string(raw, '$.time.created'),
          json_extract_string(raw, '$.timestamp')
        )::TIMESTAMP AS ts,
        coalesce(
          json_extract_string(raw, '$.role'),
          json_extract_string(raw, '$.message.role')
        ) AS role,
        coalesce(
          json_extract_string(raw, '$.providerID'),
          json_extract_string(raw, '$.provider'),
          json_extract_string(raw, '$.model.providerID')
        ) AS provider,
        coalesce(
          json_extract_string(raw, '$.modelID'),
          json_extract_string(raw, '$.model'),
          json_extract_string(raw, '$.model.modelID')
        ) AS model,
        coalesce(
          json_extract_string(raw, '$.text'),
          json_extract_string(raw, '$.content'),
          json_extract_string(raw, '$.message.content'),
          json_extract_string(raw, '$.parts[0].text')
        ) AS text,
        raw
      FROM opencode_raw
    `);
  }

  private async bootstrapBronzeViews(): Promise<void> {
    const connection = this.requireConnection();
    const discovered = await discoverTraceFiles(this.config);
    await connection.runAndReadAll("DELETE FROM source_files");
    await this.upsertSourceFiles(discovered);

    await this.dropRelation("codex_raw");
    await connection.runAndReadAll(`
      CREATE VIEW codex_raw AS
      ${this.codexRawSelectSql(discovered.filter((file) => file.source === "codex").map((file) => file.path))}
    `);

    await this.dropRelation("claude_raw");
    await connection.runAndReadAll(`
      CREATE VIEW claude_raw AS
      ${this.jsonlRawSelectSql("claude", discovered.filter((file) => file.source === "claude").map((file) => file.path))}
    `);

    await this.loadSqliteExtension();
    await this.dropRelation("cursor_raw");
    await connection.runAndReadAll(`
      CREATE VIEW cursor_raw AS
      ${this.cursorRawSelectSql(discovered.filter((file) => file.source === "cursor").map((file) => file.path))}
    `);

    await this.dropRelation("opencode_raw");
    await connection.runAndReadAll(`
      CREATE VIEW opencode_raw AS
      ${this.openCodeRawSelectSql(discovered.filter((file) => file.source === "opencode").map((file) => file.path))}
    `);
  }

  private codexRawSelectSql(files: string[]): string {
    return this.jsonlRawSelectSql("codex", files);
  }

  private jsonlRawSelectSql(source: "codex" | "claude", files: string[]): string {
    if (files.length === 0) {
      return emptySelect({
        source: "'codex'::VARCHAR".replace("codex", source),
        filename: "NULL::VARCHAR",
        line_number: "NULL::BIGINT",
        raw: "NULL::JSON",
      });
    }
    return `
      SELECT
        ${sqlString(source)} AS source,
        filename,
        row_number() OVER (PARTITION BY filename) AS line_number,
        json AS raw
      FROM read_ndjson_objects(${sqlStringList(files)}, filename = true)
    `;
  }

  private cursorRawSelectSql(files: string[]): string {
    if (files.length === 0) {
      return emptySelect({
        source: "'cursor'::VARCHAR",
        filename: "NULL::VARCHAR",
        store_table: "NULL::VARCHAR",
        row_number: "NULL::BIGINT",
        key: "NULL::VARCHAR",
        value_text: "NULL::VARCHAR",
        value_blob: "NULL::BLOB",
      });
    }
    return files.map((file) => {
      const safeFile = sqlString(file);
      return `
        SELECT
          'cursor' AS source,
          ${safeFile} AS filename,
          'meta' AS store_table,
          row_number() OVER () AS row_number,
          key::VARCHAR AS key,
          value::VARCHAR AS value_text,
          NULL::BLOB AS value_blob
        FROM sqlite_scan(${safeFile}, 'meta')

        UNION ALL

        SELECT
          'cursor' AS source,
          ${safeFile} AS filename,
          'blobs' AS store_table,
          row_number() OVER () AS row_number,
          id::VARCHAR AS key,
          NULL::VARCHAR AS value_text,
          data AS value_blob
        FROM sqlite_scan(${safeFile}, 'blobs')
      `;
    }).join("\nUNION ALL\n");
  }

  private openCodeRawSelectSql(files: string[]): string {
    if (files.length === 0) {
      return emptySelect({
        source: "'opencode'::VARCHAR",
        filename: "NULL::VARCHAR",
        kind: "NULL::VARCHAR",
        session_id: "NULL::VARCHAR",
        line_number: "NULL::BIGINT",
        raw: "NULL::JSON",
      });
    }
    return `
      SELECT
        'opencode' AS source,
        filename,
        CASE
          WHEN contains(filename, '/storage/session/') THEN 'session'
          WHEN contains(filename, '/storage/message/') THEN 'message'
          ELSE 'unknown'
        END AS kind,
        CASE
          WHEN contains(filename, '/storage/session/') THEN regexp_extract(filename, '/storage/session/(.*)\\.json$', 1)
          WHEN contains(filename, '/storage/message/') THEN regexp_extract(filename, '/storage/message/([^/]+)/', 1)
          ELSE NULL
        END AS session_id,
        row_number() OVER (PARTITION BY filename) AS line_number,
        json AS raw
      FROM read_json_objects(${sqlStringList(files)}, filename = true)
    `;
  }

  private messagesSelectSql(): string {
    return `
      SELECT
        md5('codex:' || filename || ':' || line_number::VARCHAR) AS message_key,
        source,
        coalesce(turn_id, filename) AS session_id,
        line_number AS source_row_number,
        ts,
        coalesce(role, CASE
          WHEN tool_name IS NOT NULL OR call_id IS NOT NULL OR payload_type IN ('function_call', 'function_call_output') THEN 'tool'
          WHEN payload_type = 'agent_message' THEN 'assistant'
          WHEN payload_type = 'user_message' THEN 'user'
          WHEN event_type = 'user_message' THEN 'user'
          WHEN event_type = 'agent_message' THEN 'assistant'
          ELSE 'event'
        END) AS role,
        text,
        tool_name,
        call_id AS tool_call_id,
        NULL::VARCHAR AS model,
        filename,
        raw
      FROM codex_events
      WHERE text IS NOT NULL
        OR role IS NOT NULL
        OR tool_name IS NOT NULL
        OR call_id IS NOT NULL

      UNION ALL

      SELECT
        md5('claude:' || filename || ':' || line_number::VARCHAR) AS message_key,
        source,
        coalesce(session_id, filename) AS session_id,
        line_number AS source_row_number,
        ts,
        coalesce(role, CASE
          WHEN tool_name IS NOT NULL THEN 'tool'
          ELSE 'event'
        END) AS role,
        text,
        tool_name,
        NULL::VARCHAR AS tool_call_id,
        NULL::VARCHAR AS model,
        filename,
        raw
      FROM claude_events
      WHERE text IS NOT NULL
        OR role IS NOT NULL
        OR tool_name IS NOT NULL

      UNION ALL

      SELECT
        md5('cursor:' || filename || ':' || row_number::VARCHAR) AS message_key,
        source,
        coalesce(session_id, filename) AS session_id,
        row_number AS source_row_number,
        ts,
        coalesce(role, 'event') AS role,
        text,
        tool_name,
        tool_call_id,
        NULL::VARCHAR AS model,
        filename,
        raw
      FROM cursor_events
      WHERE text IS NOT NULL
        OR role IS NOT NULL
        OR tool_name IS NOT NULL
        OR tool_call_id IS NOT NULL

      UNION ALL

      SELECT
        md5('opencode:' || filename || ':' || line_number::VARCHAR) AS message_key,
        source,
        coalesce(session_id, filename) AS session_id,
        line_number AS source_row_number,
        ts,
        coalesce(role, 'event') AS role,
        text,
        NULL::VARCHAR AS tool_name,
        NULL::VARCHAR AS tool_call_id,
        model,
        filename,
        raw
      FROM opencode_events
      WHERE kind = 'message'
        AND (text IS NOT NULL OR role IS NOT NULL)
    `;
  }

  private conversationsSelectSql(): string {
    return `
      WITH ranked AS (
        SELECT
          *,
          row_number() OVER (
            PARTITION BY source, session_id
            ORDER BY CASE WHEN role = 'user' AND text IS NOT NULL THEN 0 ELSE 1 END, ts NULLS LAST, source_row_number
          ) AS first_user_rank,
          row_number() OVER (
            PARTITION BY source, session_id
            ORDER BY CASE WHEN text IS NOT NULL THEN 0 ELSE 1 END, ts DESC NULLS LAST, source_row_number DESC
          ) AS last_text_rank
        FROM messages
      )
      SELECT
        md5(source || ':' || session_id) AS conversation_key,
        source,
        session_id,
        min(ts) AS started_at,
        max(ts) AS ended_at,
        count(*) AS message_count,
        count(*) FILTER (WHERE tool_name IS NOT NULL OR tool_call_id IS NOT NULL OR role = 'tool') AS tool_call_count,
        max(CASE WHEN role = 'user' AND first_user_rank = 1 THEN text END) AS first_user_text,
        max(CASE WHEN last_text_rank = 1 THEN text END) AS last_text
      FROM ranked
      GROUP BY source, session_id
    `;
  }

  private toolCallsSelectSql(): string {
    return `
      SELECT
        message_key AS tool_call_key,
        source,
        session_id,
        ts,
        role,
        tool_name,
        tool_call_id,
        CASE WHEN role <> 'tool' THEN text END AS input_text,
        CASE WHEN role = 'tool' THEN text END AS output_text,
        filename,
        raw
      FROM messages
      WHERE tool_name IS NOT NULL
        OR tool_call_id IS NOT NULL
        OR role = 'tool'
    `;
  }

  private async createGoldSearchIndexes(): Promise<void> {
    await this.loadFtsExtension();
    const connection = this.requireConnection();
    await connection.runAndReadAll(`
      PRAGMA create_fts_index(
        'messages',
        'message_key',
        'text',
        overwrite = 1
      )
    `);
    await connection.runAndReadAll(`
      PRAGMA create_fts_index(
        'tool_calls',
        'tool_call_key',
        'input_text',
        'output_text',
        overwrite = 1
      )
    `);
    await connection.runAndReadAll(`
      PRAGMA create_fts_index(
        'conversations',
        'conversation_key',
        'first_user_text',
        'last_text',
        overwrite = 1
      )
    `);
  }

  private requireConnection(): DuckDBConnection {
    if (!this.connection) {
      throw new Error("Memory DuckDB is closed");
    }
    return this.connection;
  }
}

export function formatQueryResult(result: QueryResult): string {
  const rows = result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column, index) => [column, row[index] ?? null])),
  );
  return JSON.stringify(
    {
      rows,
      rowCount: result.rowCount,
      elapsedMs: Number(result.elapsedMs.toFixed(1)),
    },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

export function resolveMemoryConfig(config: Partial<MemoryConfig> = {}): MemoryConfig {
  const cwd =
    config.cwd ??
    process.env.TRACEPOND_CWD ??
    process.cwd();
  const codexHome =
    config.codexHome ??
    process.env.TRACEPOND_CODEX_HOME ??
    process.env.CODEX_HOME ??
    path.join(home(), ".codex");
  const claudeHome =
    config.claudeHome ??
    process.env.TRACEPOND_CLAUDE_HOME ??
    process.env.CLAUDE_HOME ??
    path.join(home(), ".claude");
  const cursorHome =
    config.cursorHome ??
    process.env.TRACEPOND_CURSOR_HOME ??
    process.env.CURSOR_HOME ??
    path.join(home(), ".cursor");
  const opencodeDataDirs =
    config.opencodeDataDirs ??
    splitCommaList(process.env.TRACEPOND_OPENCODE_DATA_DIRS) ??
    splitCommaList(process.env.OPENCODE_DATA_DIR) ??
    [path.join(home(), ".local", "share", "opencode")];
  const databasePath =
    config.databasePath ??
    process.env.TRACEPOND_DATABASE_PATH ??
    path.join(home(), ".tracepond", "tracepond.duckdb");
  const refreshIntervalMs =
    config.refreshIntervalMs ??
    parseDurationMs(process.env.TRACEPOND_REFRESH_INTERVAL) ??
    defaultRefreshIntervalMs;

  return {
    cwd: path.resolve(cwd),
    codexHome: path.resolve(codexHome),
    claudeHome: path.resolve(claudeHome),
    cursorHome: path.resolve(cursorHome),
    opencodeDataDirs: opencodeDataDirs.map((dir) => path.resolve(dir)),
    databasePath: path.resolve(databasePath),
    client: config.client ?? process.env.TRACEPOND_CLIENT ?? "unknown",
    refreshIntervalMs,
  };
}

async function discoverTraceFiles(config: MemoryConfig): Promise<Array<{
  source: TraceSource;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}>> {
  const candidates = [
    ...(await walkFiles(path.join(config.codexHome, "sessions"), 100_000))
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => ({ source: "codex" as const, path: file })),
    ...(await walkFiles(path.join(config.claudeHome, "projects"), 100_000))
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => ({ source: "claude" as const, path: file })),
    ...(await walkFiles(path.join(config.cursorHome, "chats"), 100_000))
      .filter((file) => path.basename(file) === "store.db")
      .map((file) => ({ source: "cursor" as const, path: file })),
    ...(await discoverOpenCodeFiles(config)),
  ];
  const claudeHistory = path.join(config.claudeHome, "history.jsonl");
  if (await exists(claudeHistory)) {
    candidates.push({ source: "claude", path: claudeHistory });
  }

  const files = [];
  for (const candidate of candidates) {
    const metadata = await safeStat(candidate.path);
    if (!metadata) {
      continue;
    }
    files.push({
      source: candidate.source,
      path: candidate.path,
      sizeBytes: metadata.size,
      mtimeMs: metadata.mtime.getTime(),
    });
  }
  return files;
}

async function discoverOpenCodeFiles(config: MemoryConfig): Promise<Array<{
  source: "opencode";
  path: string;
}>> {
  const files = [];
  for (const dir of config.opencodeDataDirs) {
    files.push(
      ...(await walkFiles(path.join(dir, "storage", "session"), 100_000))
        .filter((file) => file.endsWith(".json"))
        .map((file) => ({ source: "opencode" as const, path: file })),
      ...(await walkFiles(path.join(dir, "storage", "message"), 100_000))
        .filter((file) => file.endsWith(".json"))
        .map((file) => ({ source: "opencode" as const, path: file })),
    );
  }
  return files;
}

async function walkFiles(root: string, maxFiles: number): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }
  const stack = [root];
  const files: string[] = [];
  while (stack.length > 0 && files.length < maxFiles) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (![".git", "node_modules", "dist"].includes(entry.name)) {
          stack.push(file);
        }
      } else if (entry.isFile()) {
        files.push(file);
        if (files.length >= maxFiles) {
          break;
        }
      }
    }
  }
  return files;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function safeStat(file: string): Promise<{ mtime: Date; size: number } | null> {
  try {
    const metadata = await stat(file);
    return { mtime: metadata.mtime, size: metadata.size };
  } catch {
    return null;
  }
}

function writableDuckDbOptions(): Record<string, string> {
  return {
    access_mode: "READ_WRITE",
    enable_external_access: "true",
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
  };
}

function readOnlyDuckDbOptions(): Record<string, string> {
  return {
    access_mode: "READ_ONLY",
    enable_external_access: "true",
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
  };
}

export function parseDurationMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const parsed = ms(trimmed as ms.StringValue);
  if (typeof parsed === "number" && Number.isFinite(parsed)) {
    return parsed;
  }
  throw new Error(`Invalid refresh interval: ${value}. Use values like 0, 30s, 5m, 1h, or 1d.`);
}

function assertSafeReadOnlySql(sql: string): void {
  const trimmed = sql.trim().replace(/^--.*$/gm, "").trim().toLowerCase();
  if (!/^(select|with|describe|show|summarize|explain|pragma\s+table_info)\b/.test(trimmed)) {
    throw new Error("tracepond.query only accepts read-only DuckDB SQL");
  }
  if (/\b(copy|insert|update|delete|drop|alter|create|attach|detach|install|load|call|export|import)\b/i.test(sql)) {
    throw new Error("tracepond.query rejected a side-effecting statement");
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlStringList(values: string[]): string {
  return `[${values.map(sqlString).join(", ")}]`;
}

function emptySelect(columns: Record<string, string>): string {
  return `SELECT ${Object.entries(columns)
    .map(([name, expression]) => `${expression} AS ${name}`)
    .join(", ")} WHERE false`;
}

function home(): string {
  return os.homedir();
}

function splitCommaList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}
