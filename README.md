# tracepond

[![License](https://img.shields.io/badge/license-MIT-007ec6?style=flat-square)](LICENSE)

DuckDB SQL over local coding-agent traces and memories. Persistent cache, read-only queries, no hosted service.

---

## Install

```sh
npm install -g @satoric-tech/tracepond
```

For local development:

```sh
npm install
npm run build
npm link
```

---

## Usage

**Describe available tables and views**

```sh
tracepond describe
```

**Query recent Codex messages**

```sh
tracepond query "
  SELECT ts, role, substr(text, 1, 160) AS text
  FROM codex_events
  WHERE text IS NOT NULL
  ORDER BY ts DESC
  LIMIT 10
"
```

**Search Cursor chats**

```sh
tracepond query "
  SELECT session_id, role, substr(text, 1, 160) AS text
  FROM cursor_events
  WHERE text ILIKE '%deploy%'
  LIMIT 10
"
```

**Inspect cached files**

```sh
tracepond query "
  SELECT source, count(*) AS files, max(ingested_at) AS refreshed_at
  FROM source_files
  GROUP BY 1
  ORDER BY 1
"
```

---

## MCP

Run the MCP server over stdio:

```sh
tracepond mcp
```

Tools:

| Tool | Description |
|---|---|
| `query` | Run read-only DuckDB SQL over local traces and memories |
| `describe` | Show resolved paths, available views, schemas, and examples |

Compatibility aliases are also registered as `tracepond.query` and `tracepond.describe`.

---

## Sources

Tracepond discovers local files from standard agent locations:

| Source | Paths |
|---|---|
| Codex | `~/.codex/sessions/**/*.jsonl`, `~/.codex/memories/**`, `~/.codex/memories_extensions/**` |
| Claude Code | `~/.claude/projects/**/*.jsonl`, `~/.claude/history.jsonl`, `~/.claude/projects/*/memory/**/*.md` |
| Cursor | `~/.cursor/chats/*/*/store.db` |
| OpenCode | `~/.local/share/opencode/storage/session/**/*.json`, `~/.local/share/opencode/storage/message/**/*.json` |
| Workspace | `AGENTS.md`, `CLAUDE.md` |

Trace rows are cached in `~/.tracepond/tracepond.duckdb` by default. Source files are tracked by path, size, and mtime. Only changed files are refreshed before the database is reopened read-only with external access disabled.

---

## Data Layers

### Bronze

Bronze tables cache source records with minimal transformation.

| Table | Grain |
|---|---|
| `codex_raw` | One JSONL row from Codex session logs |
| `claude_raw` | One JSONL row from Claude Code logs |
| `cursor_raw` | One Cursor SQLite `meta` or `blobs` row |
| `opencode_raw` | One OpenCode session or message JSON record |

### Silver

Silver views normalize each source into queryable event columns.

| View | Common columns |
|---|---|
| `codex_events` | `source`, `filename`, `line_number`, `ts`, `event_type`, `payload_type`, `turn_id`, `role`, `tool_name`, `call_id`, `text`, `raw` |
| `claude_events` | `source`, `filename`, `line_number`, `ts`, `event_type`, `subtype`, `session_id`, `role`, `content_type`, `tool_name`, `text`, `raw` |
| `cursor_events` | `source`, `filename`, `row_number`, `workspace_id`, `session_id`, `blob_id`, `ts`, `role`, `message_id`, `content_type`, `tool_name`, `tool_call_id`, `text`, `raw` |
| `opencode_events` | `source`, `filename`, `kind`, `session_id`, `line_number`, `ts`, `role`, `provider`, `model`, `text`, `raw` |

### Control

| Table | Description |
|---|---|
| `source_files` | Cache manifest with `source`, `path`, `size_bytes`, `mtime_ms`, and `ingested_at` |
| `memory_documents` | Markdown and text memories or workspace instructions |

---

## Gold Schemas

Gold should model cross-source product concepts. Keep these as views first, then materialize only if query time or ranking cost requires it.

### `messages`

One row per user, assistant, system, or tool message across all sources.

| Column | Type | Notes |
|---|---|---|
| `message_key` | `VARCHAR` | Stable hash of source, filename, and source row id |
| `source` | `VARCHAR` | `codex`, `claude`, `cursor`, or `opencode` |
| `session_id` | `VARCHAR` | Native session, turn, or conversation id when available |
| `ts` | `TIMESTAMP` | Event timestamp when available |
| `role` | `VARCHAR` | `system`, `user`, `assistant`, `tool`, or source-specific role |
| `text` | `VARCHAR` | Searchable text |
| `tool_name` | `VARCHAR` | Tool name when the message represents tool usage |
| `model` | `VARCHAR` | Model id when available |
| `filename` | `VARCHAR` | Source file path |
| `raw` | `JSON` | Source payload |

### `conversations`

One row per session-like conversation.

| Column | Type | Notes |
|---|---|---|
| `conversation_key` | `VARCHAR` | Stable hash of source and session id |
| `source` | `VARCHAR` | Trace source |
| `session_id` | `VARCHAR` | Native session id |
| `started_at` | `TIMESTAMP` | First message timestamp |
| `ended_at` | `TIMESTAMP` | Last message timestamp |
| `message_count` | `BIGINT` | Messages in the conversation |
| `tool_call_count` | `BIGINT` | Tool messages or calls |
| `first_user_text` | `VARCHAR` | Short title candidate |
| `last_text` | `VARCHAR` | Last non-empty message text |

### `tool_calls`

One row per normalized tool call or tool result.

| Column | Type | Notes |
|---|---|---|
| `tool_call_key` | `VARCHAR` | Stable hash of source row identity |
| `source` | `VARCHAR` | Trace source |
| `session_id` | `VARCHAR` | Conversation id |
| `ts` | `TIMESTAMP` | Call or result timestamp |
| `role` | `VARCHAR` | Usually `tool` or source equivalent |
| `tool_name` | `VARCHAR` | Tool name |
| `tool_call_id` | `VARCHAR` | Native call id when available |
| `input_text` | `VARCHAR` | Arguments or command text when available |
| `output_text` | `VARCHAR` | Result text when available |
| `raw` | `JSON` | Source payload |

### `search_documents`

One row per searchable chunk. This is the best first gold table for BM25.

| Column | Type | Notes |
|---|---|---|
| `document_key` | `VARCHAR` | Stable hash of source row plus chunk index |
| `source` | `VARCHAR` | Trace or memory source |
| `kind` | `VARCHAR` | `message`, `tool_call`, `memory`, `instruction`, or `conversation` |
| `session_id` | `VARCHAR` | Conversation id when available |
| `ts` | `TIMESTAMP` | Timestamp when available |
| `title` | `VARCHAR` | File title, first prompt, or conversation label |
| `text` | `VARCHAR` | Chunk text for search |
| `metadata` | `JSON` | Compact source metadata |

Use DuckDB full text search or a BM25 extension over `search_documents` before adding vector embeddings. Embeddings are useful later for semantic recall, but they add model choice, storage, refresh, and privacy decisions.

---

## Options

### CLI flags

| Flag | Description | Default |
|---|---|---|
| `--codex-home PATH` | Codex home directory | `~/.codex` |
| `--claude-home PATH` | Claude home directory | `~/.claude` |
| `--cursor-home PATH` | Cursor home directory | `~/.cursor` |
| `--opencode-data-dir PATH` | OpenCode data directory, repeatable | `~/.local/share/opencode` |
| `--database-path PATH` | Persistent DuckDB cache path | `~/.tracepond/tracepond.duckdb` |
| `--workspace-root PATH` | Workspace root, repeatable | current directory |
| `--cwd PATH` | Current working directory override | current directory |

### Environment variables

| Variable | Description |
|---|---|
| `TRACEPOND_CODEX_HOME` | Codex home directory |
| `TRACEPOND_CLAUDE_HOME` | Claude home directory |
| `TRACEPOND_CURSOR_HOME` | Cursor home directory |
| `TRACEPOND_OPENCODE_DATA_DIRS` | Comma-separated OpenCode data directories |
| `TRACEPOND_DATABASE_PATH` | Persistent DuckDB cache path |
| `TRACEPOND_WORKSPACE_ROOTS` | Path-list of workspace roots |
| `TRACEPOND_CWD` | Current working directory override |

---

## Development

```sh
npm install
npm run check
npm run build
npm run smoke
```

---

## License

MIT - built by [Satoric](https://satoric.com)
