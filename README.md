# tracepond

[![License](https://img.shields.io/badge/license-MIT-007ec6?style=flat-square)](LICENSE)

DuckDB over local coding-agent traces, available as a CLI, TypeScript SDK, and MCP server.

## Install

```sh
npm install -g @satoric-tech/tracepond
```

## CLI

Use `describe` to inspect the local Tracepond schema.

```sh
tracepond describe
```

Query normalized messages with read-only DuckDB SQL.

```sh
tracepond query "
  SELECT source, ts, role, substr(text, 1, 160) AS text
  FROM messages
  WHERE text ILIKE '%deploy%'
  ORDER BY ts DESC
  LIMIT 10
"
```

Search is always available through DuckDB FTS indexes on gold tables.

```sh
tracepond query "
  SELECT source, ts, role, substr(text, 1, 160) AS text,
         fts_main_messages.match_bm25(message_key, 'deploy') AS score
  FROM messages
  WHERE score IS NOT NULL
  ORDER BY score DESC
  LIMIT 10
"
```

Force a gold table and FTS refresh when you want fresh results immediately.

```sh
tracepond refresh
```

## SDK

The TypeScript SDK exposes the same `describe`, `query`, and `refresh` surface.

```ts
import { describe, query, refresh } from "@satoric-tech/tracepond";

console.log(await describe());

const result = await query(`
  SELECT source, session_id, message_count, first_user_text
  FROM conversations
  ORDER BY ended_at DESC NULLS LAST
  LIMIT 10
`);

await refresh();
```

Pass source homes, Tracepond home, or refresh timing as SDK options.

```ts
await query("SELECT count(*) FROM messages", {
  refreshIntervalMs: 300_000,
});
```

## MCP

Run the MCP server over stdio when connecting Tracepond to an agent.

```sh
tracepond mcp
```

The MCP server exposes only two tools.

- `query`: run read-only DuckDB SQL.
- `describe`: show config, schemas, and examples.

## Data

Tracepond reads these local trace sources.

- Codex: `~/.codex/sessions/**/*.jsonl`
- Claude Code: `~/.claude/projects/**/*.jsonl`, `~/.claude/history.jsonl`
- Cursor: `~/.cursor/chats/*/*/store.db`
- OpenCode: `~/.local/share/opencode/storage/session/**/*.json`, `~/.local/share/opencode/storage/message/**/*.json`

### Bronze

Bronze views expose raw source-shaped rows.

| View | Columns |
|---|---|
| `codex_raw` | `source`, `filename`, `line_number`, `raw` |
| `claude_raw` | `source`, `filename`, `line_number`, `raw` |
| `cursor_raw` | `source`, `filename`, `store_table`, `row_number`, `key`, `value_text`, `value_blob` |
| `opencode_raw` | `source`, `filename`, `kind`, `session_id`, `line_number`, `raw` |

### Silver

Silver views normalize each source into event rows.

| View | Columns |
|---|---|
| `codex_events` | `source`, `filename`, `line_number`, `ts`, `event_type`, `payload_type`, `turn_id`, `role`, `tool_name`, `call_id`, `text`, `raw` |
| `claude_events` | `source`, `filename`, `line_number`, `ts`, `event_type`, `subtype`, `session_id`, `role`, `content_type`, `tool_name`, `text`, `raw` |
| `cursor_events` | `source`, `filename`, `row_number`, `workspace_id`, `session_id`, `blob_id`, `ts`, `role`, `message_id`, `content_type`, `tool_name`, `tool_call_id`, `text`, `raw` |
| `opencode_events` | `source`, `filename`, `kind`, `session_id`, `line_number`, `ts`, `role`, `provider`, `model`, `text`, `raw` |

### Gold

Gold tables are the stable cross-source query surface.

| Table | Columns |
|---|---|
| `messages` | `message_key`, `source`, `session_id`, `source_row_number`, `ts`, `role`, `text`, `tool_name`, `tool_call_id`, `model`, `filename`, `raw` |
| `conversations` | `conversation_key`, `source`, `session_id`, `started_at`, `ended_at`, `message_count`, `tool_call_count`, `first_user_text`, `last_text` |
| `tool_calls` | `tool_call_key`, `source`, `session_id`, `ts`, `role`, `tool_name`, `tool_call_id`, `input_text`, `output_text`, `filename`, `raw` |

FTS indexes are created directly on gold tables.

- `messages`: `fts_main_messages.match_bm25(message_key, 'query')`
- `tool_calls`: `fts_main_tool_calls.match_bm25(tool_call_key, 'query')`
- `conversations`: `fts_main_conversations.match_bm25(conversation_key, 'query')`

Gold tables refresh every 5 minutes by default.

```sh
tracepond set refresh.interval 5m
```

## Config

Configuration is stored in the Tracepond home.

```sh
tracepond get
tracepond get codex.home
tracepond set codex.home ~/.codex
tracepond unset codex.home
tracepond config-path
```

Environment variables override saved config for temporary changes.

| Config key | Env var | Default |
|---|---|---|
| `tracepond.home` | `TRACEPOND_HOME` | `~/.tracepond` |
| `codex.home` | `TRACEPOND_CODEX_HOME` | `~/.codex` |
| `claude.home` | `TRACEPOND_CLAUDE_HOME` | `~/.claude` |
| `cursor.home` | `TRACEPOND_CURSOR_HOME` | `~/.cursor` |
| `opencode.home` | `TRACEPOND_OPENCODE_HOME` | `~/.local/share/opencode` |
| `refresh.interval` | `TRACEPOND_REFRESH_INTERVAL` | `5m` |

Refresh intervals use standard duration strings, such as `0`, `30s`, `5m`, `1h`, or `1d`.

## Development

Install dependencies and run the local checks.

```sh
npm install
npm run check
npm run test
npm run build
```

## License

MIT
