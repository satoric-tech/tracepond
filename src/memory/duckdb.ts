import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";

export type QueryResult = {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  elapsedMs: number;
};

export type MemoryConfig = {
  cwd: string;
  codexHome: string;
  claudeHome: string;
  cursorHome: string;
  opencodeDataDirs: string[];
  databasePath: string;
  client: string;
  workspaceRoots: string[];
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
        AND table_name IN ('source_files', 'codex_raw', 'codex_events', 'claude_raw', 'claude_events', 'cursor_raw', 'cursor_events', 'opencode_raw', 'opencode_events', 'memory_documents')
      ORDER BY table_name, column_index
    `);

    return [
      "tracepond exposes read-only DuckDB SQL over local coding-agent traces and memories.",
      "",
      "Resolved config:",
      `- client: ${this.config.client}`,
      `- cwd: ${this.config.cwd}`,
      `- database_path: ${this.config.databasePath}`,
      `- codex_home: ${this.config.codexHome}`,
      `- claude_home: ${this.config.claudeHome}`,
      `- cursor_home: ${this.config.cursorHome}`,
      `- opencode_data_dirs: ${this.config.opencodeDataDirs.join(", ") || "(none)"}`,
      `- workspace_roots: ${this.config.workspaceRoots.join(", ") || "(none)"}`,
      "",
      "Core views:",
      "- codex_raw: raw Codex JSONL rows materialized from <codex_home>/sessions/**/*.jsonl",
      "- codex_events: extracted Codex event fields plus raw JSON",
      "- claude_raw: raw Claude Code JSONL rows materialized from <claude_home>/projects/**/*.jsonl and <claude_home>/history.jsonl",
      "- claude_events: extracted Claude event fields plus raw JSON",
      "- cursor_raw: raw Cursor SQLite rows materialized from <cursor_home>/chats/*/*/store.db",
      "- cursor_events: extracted Cursor message/tool fields from decoded blob JSON",
      "- opencode_raw: raw OpenCode JSON rows materialized from <opencode_data_dir>/storage/session/**/*.json and <opencode_data_dir>/storage/message/**/*.json",
      "- opencode_events: extracted OpenCode event/session fields plus raw JSON",
      "- memory_documents: Markdown/text memory and instruction files",
      "- source_files: manifest of cached source files, mtimes, sizes, and ingest timestamps",
      "",
      "User queries run against a DuckDB database reopened with access_mode=READ_ONLY and enable_external_access=false.",
      "",
      "`line_number` is the JSONL row number within the scanned file.",
      "",
      "Schema:",
      formatQueryResult(result),
      "",
      "Example queries:",
      "SELECT event_type, payload_type, count(*) FROM codex_events GROUP BY 1, 2 ORDER BY 3 DESC;",
      "SELECT ts, filename, line_number, text FROM codex_events WHERE text ILIKE '%corpus_mente%' ORDER BY ts LIMIT 20;",
      "SELECT tool_name, count(*) FROM codex_events WHERE payload_type = 'function_call' GROUP BY 1 ORDER BY 2 DESC;",
      "SELECT session_id, role, substr(text, 1, 120) FROM cursor_events WHERE text ILIKE '%deploy%' LIMIT 10;",
      "SELECT source, path, title, text FROM memory_documents WHERE text ILIKE '%secrets%' LIMIT 10;",
    ].join("\n");
  }

  private async initialize(): Promise<void> {
    await mkdir(path.dirname(this.config.databasePath), { recursive: true });

    this.instance = await DuckDBInstance.create(this.config.databasePath, writableDuckDbOptions());
    this.connection = await this.instance.connect();
    await this.bootstrapSchema();
    await this.refreshTraceFiles();
    await this.bootstrapViews();
    await this.bootstrapMemoryDocuments();

    this.connection.closeSync();
    this.connection = null;
    this.instance.closeSync();
    this.instance = null;

    this.instance = await DuckDBInstance.create(this.config.databasePath, readOnlyDuckDbOptions());
    this.connection = await this.instance.connect();
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
      CREATE TABLE IF NOT EXISTS codex_raw (
        source VARCHAR,
        filename VARCHAR,
        line_number BIGINT,
        raw JSON
      )
    `);

    await connection.runAndReadAll(`
      CREATE TABLE IF NOT EXISTS claude_raw (
        source VARCHAR,
        filename VARCHAR,
        line_number BIGINT,
        raw JSON
      )
    `);

    await connection.runAndReadAll(`
      CREATE TABLE IF NOT EXISTS cursor_raw (
        source VARCHAR,
        filename VARCHAR,
        store_table VARCHAR,
        row_number BIGINT,
        key VARCHAR,
        value_text VARCHAR,
        value_blob BLOB
      )
    `);

    await connection.runAndReadAll(`
      CREATE TABLE IF NOT EXISTS opencode_raw (
        source VARCHAR,
        filename VARCHAR,
        kind VARCHAR,
        session_id VARCHAR,
        line_number BIGINT,
        raw JSON
      )
    `);

    await connection.runAndReadAll(`
      CREATE INDEX IF NOT EXISTS source_files_path_idx ON source_files(path)
    `);
    await connection.runAndReadAll(`
      CREATE INDEX IF NOT EXISTS codex_raw_filename_idx ON codex_raw(filename)
    `);
    await connection.runAndReadAll(`
      CREATE INDEX IF NOT EXISTS claude_raw_filename_idx ON claude_raw(filename)
    `);
    await connection.runAndReadAll(`
      CREATE INDEX IF NOT EXISTS cursor_raw_filename_idx ON cursor_raw(filename)
    `);
    await connection.runAndReadAll(`
      CREATE INDEX IF NOT EXISTS opencode_raw_filename_idx ON opencode_raw(filename)
    `);
  }

  private async refreshTraceFiles(): Promise<void> {
    const connection = this.requireConnection();
    const discovered = await discoverTraceFiles(this.config);
    const currentPaths = new Set(discovered.map((file) => file.path));

    const existingReader = await connection.runAndReadAll(`
      SELECT source, path, size_bytes, mtime_ms
      FROM source_files
      WHERE source IN ('codex', 'claude', 'cursor', 'opencode')
    `);
    const existingRows = existingReader.getRowsJson() as unknown[][];
    const existing = new Map(
      existingRows.map((row) => [
        String(row[1]),
        {
          source: String(row[0]),
          path: String(row[1]),
          size_bytes: row[2] as number | bigint | string,
          mtime_ms: row[3] as number | bigint | string,
        },
      ]),
    );

    for (const source of ["codex", "claude", "cursor", "opencode"] as const) {
      const sourceFiles = discovered.filter((file) => file.source === source);
      const existingSourceRows = [...existing.values()].filter((row) => row.source === source);
      const changedFiles = sourceFiles.filter((file) => {
        const previous = existing.get(file.path);
        return !previous ||
          BigInt(previous.size_bytes) !== BigInt(file.sizeBytes) ||
          BigInt(previous.mtime_ms) !== BigInt(file.mtimeMs);
      });
      const deletedFiles = existingSourceRows.filter((row) => !currentPaths.has(row.path));

      if (existingSourceRows.length === 0 || changedFiles.length + deletedFiles.length > 100) {
        await this.bulkRefreshSource(source, sourceFiles);
        continue;
      }

      for (const row of deletedFiles) {
        await this.deleteTraceFileRows(row.source, row.path);
        await connection.runAndReadAll(`DELETE FROM source_files WHERE path = ${sqlString(row.path)}`);
      }

      for (const file of changedFiles) {
        await this.deleteTraceFileRows(file.source, file.path);
        await this.insertTraceFileRows(file.source, file.path);
      }
      await this.upsertSourceFiles(changedFiles);
    }
  }

  private async bulkRefreshSource(
    source: TraceSource,
    files: Array<{ source: TraceSource; path: string; sizeBytes: number; mtimeMs: number }>,
  ): Promise<void> {
    const connection = this.requireConnection();
    const table = rawTableForSource(source);
    await connection.runAndReadAll(`DELETE FROM ${table} WHERE source = ${sqlString(source)}`);
    await connection.runAndReadAll(`DELETE FROM source_files WHERE source = ${sqlString(source)}`);
    if (files.length === 0) {
      return;
    }
    if (source === "cursor") {
      await this.loadSqliteExtension();
      for (const file of files) {
        await this.insertCursorFileRows(file.path);
      }
    } else if (source === "opencode") {
      for (const file of files) {
        await this.insertOpenCodeFileRows(file.path);
      }
    } else {
      await connection.runAndReadAll(`
        INSERT INTO ${table}
        SELECT
          ${sqlString(source)} AS source,
          filename,
          row_number() OVER (PARTITION BY filename) AS line_number,
          json AS raw
        FROM read_ndjson_objects(${sourceReadArgument(this.config, source)}, filename = true)
      `);
    }
    await this.upsertSourceFiles(files);
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

  private async deleteTraceFileRows(source: string, file: string): Promise<void> {
    const table = rawTableForSource(source);
    await this.requireConnection().runAndReadAll(`
      DELETE FROM ${table}
      WHERE filename = ${sqlString(file)}
    `);
  }

  private async insertTraceFileRows(source: string, file: string): Promise<void> {
    if (source === "cursor") {
      await this.loadSqliteExtension();
      await this.insertCursorFileRows(file);
      return;
    }
    if (source === "opencode") {
      await this.insertOpenCodeFileRows(file);
      return;
    }
    const table = rawTableForSource(source);
    await this.requireConnection().runAndReadAll(`
      INSERT INTO ${table}
      SELECT
        ${sqlString(source)} AS source,
        filename,
        row_number() OVER (PARTITION BY filename) AS line_number,
        json AS raw
      FROM read_ndjson_objects(${sqlString(file)}, filename = true)
    `);
  }

  private async insertCursorFileRows(file: string): Promise<void> {
    const safeFile = sqlString(file);
    await this.requireConnection().runAndReadAll(`
      INSERT INTO cursor_raw
      SELECT
        'cursor' AS source,
        ${safeFile} AS filename,
        'meta' AS store_table,
        row_number() OVER () AS row_number,
        key::VARCHAR AS key,
        value::VARCHAR AS value_text,
        NULL::BLOB AS value_blob
      FROM sqlite_scan(${safeFile}, 'meta')
    `);
    await this.requireConnection().runAndReadAll(`
      INSERT INTO cursor_raw
      SELECT
        'cursor' AS source,
        ${safeFile} AS filename,
        'blobs' AS store_table,
        row_number() OVER () AS row_number,
        id::VARCHAR AS key,
        NULL::VARCHAR AS value_text,
        data AS value_blob
      FROM sqlite_scan(${safeFile}, 'blobs')
    `);
  }

  private async insertOpenCodeFileRows(file: string): Promise<void> {
    const kind = openCodeKindForPath(file);
    const sessionId = openCodeSessionIdForPath(file, kind);
    await this.requireConnection().runAndReadAll(`
      INSERT INTO opencode_raw
      SELECT
        'opencode' AS source,
        filename,
        ${sqlString(kind)} AS kind,
        ${sqlString(sessionId)} AS session_id,
        row_number() OVER (PARTITION BY filename) AS line_number,
        json AS raw
      FROM read_json_objects(${sqlString(file)}, filename = true)
    `);
  }

  private async loadSqliteExtension(): Promise<void> {
    try {
      await this.requireConnection().runAndReadAll("LOAD sqlite;");
    } catch {
      await this.requireConnection().runAndReadAll("INSTALL sqlite; LOAD sqlite;");
    }
  }

  private async bootstrapViews(): Promise<void> {
    const connection = this.requireConnection();

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

  private async bootstrapMemoryDocuments(): Promise<void> {
    const connection = this.requireConnection();
    await connection.runAndReadAll(`
      CREATE OR REPLACE TABLE memory_documents (
        id VARCHAR,
        source VARCHAR,
        kind VARCHAR,
        path VARCHAR,
        mtime TIMESTAMP,
        size_bytes BIGINT,
        title VARCHAR,
        text VARCHAR
      )
    `);

    for (const doc of await discoverMemoryDocuments(this.config)) {
      await connection.runAndReadAll(`
        INSERT INTO memory_documents
        VALUES (
          ${sqlString(doc.id)},
          ${sqlString(doc.source)},
          ${sqlString(doc.kind)},
          ${sqlString(doc.path)},
          ${sqlString(doc.mtime.toISOString())}::TIMESTAMP,
          ${doc.sizeBytes},
          ${sqlString(doc.title)},
          ${sqlString(doc.text)}
        )
      `);
    }
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
  const workspaceRoots =
    config.workspaceRoots ??
    splitPathList(process.env.TRACEPOND_WORKSPACE_ROOTS) ??
    splitPathList(process.env.WORKSPACE_ROOTS) ??
    [cwd];

  return {
    cwd: path.resolve(cwd),
    codexHome: path.resolve(codexHome),
    claudeHome: path.resolve(claudeHome),
    cursorHome: path.resolve(cursorHome),
    opencodeDataDirs: opencodeDataDirs.map((dir) => path.resolve(dir)),
    databasePath: path.resolve(databasePath),
    client: config.client ?? process.env.TRACEPOND_CLIENT ?? "unknown",
    workspaceRoots: workspaceRoots.map((root) => path.resolve(root)),
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

async function discoverMemoryDocuments(config: MemoryConfig): Promise<Array<{
  id: string;
  source: string;
  kind: string;
  path: string;
  mtime: Date;
  sizeBytes: number;
  title: string;
  text: string;
}>> {
  const files = [
    ...(await walkFiles(path.join(config.codexHome, "memories"), 300)),
    ...(await walkFiles(path.join(config.codexHome, "memories_extensions"), 300)),
    ...(await walkFiles(path.join(config.claudeHome, "projects"), 800)).filter((file) =>
      file.includes(`${path.sep}memory${path.sep}`),
    ),
    ...(await workspaceInstructionFiles(config.workspaceRoots)),
  ].filter((file) => /\.(md|markdown|txt)$/i.test(file));

  const docs = [];
  for (const file of files) {
    const [text, metadata] = await Promise.all([safeReadFile(file), safeStat(file)]);
    if (!text.trim()) {
      continue;
    }
    docs.push({
      id: idFor(file),
      source: sourceForPath(file),
      kind: file.includes(`${path.sep}memory${path.sep}`) ? "memory" : "instruction",
      path: file,
      mtime: metadata?.mtime ?? new Date(0),
      sizeBytes: metadata?.size ?? 0,
      title: titleFor(file, text),
      text,
    });
  }
  return docs;
}

async function workspaceInstructionFiles(workspaceRoots: string[]): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const root of workspaceRoots) {
    let current = path.resolve(root);
    for (let i = 0; i < 8; i += 1) {
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        const file = path.join(current, name);
        if (!seen.has(file) && (await exists(file))) {
          seen.add(file);
          files.push(file);
        }
      }
      const next = path.dirname(current);
      if (next === current || current === home()) {
        break;
      }
      current = next;
    }
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

async function safeReadFile(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
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
    enable_external_access: "false",
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
  };
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

function sourceReadArgument(config: MemoryConfig, source: "codex" | "claude"): string {
  if (source === "codex") {
    return sqlString(path.join(config.codexHome, "sessions", "**", "*.jsonl"));
  }
  return `[${
    [
      path.join(config.claudeHome, "projects", "**", "*.jsonl"),
      path.join(config.claudeHome, "history.jsonl"),
    ].map(sqlString).join(", ")
  }]`;
}

function rawTableForSource(source: string): "codex_raw" | "claude_raw" | "cursor_raw" | "opencode_raw" {
  if (source === "codex") {
    return "codex_raw";
  }
  if (source === "claude") {
    return "claude_raw";
  }
  if (source === "cursor") {
    return "cursor_raw";
  }
  if (source === "opencode") {
    return "opencode_raw";
  }
  throw new Error(`Unsupported trace source: ${source}`);
}

function openCodeKindForPath(file: string): "session" | "message" | "unknown" {
  if (file.includes(`${path.sep}storage${path.sep}session${path.sep}`)) {
    return "session";
  }
  if (file.includes(`${path.sep}storage${path.sep}message${path.sep}`)) {
    return "message";
  }
  return "unknown";
}

function openCodeSessionIdForPath(file: string, kind: string): string {
  if (kind === "message") {
    return path.basename(path.dirname(file));
  }
  if (kind === "session") {
    return path.basename(file, ".json");
  }
  return "";
}

function sourceForPath(file: string): string {
  if (file.includes(`${path.sep}.codex${path.sep}`)) {
    return "codex";
  }
  if (file.includes(`${path.sep}.claude${path.sep}`)) {
    return "claude";
  }
  return "workspace";
}

function titleFor(file: string, text: string): string {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(file);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function idFor(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function home(): string {
  return os.homedir();
}

function splitPathList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
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
