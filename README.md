# tracepond

[![License](https://img.shields.io/badge/license-MIT-007ec6?style=flat-square)](LICENSE)

DuckDB over local coding-agent traces, available as a CLI, TypeScript SDK, and MCP server.

```sh
npm install -g @satoric-tech/tracepond
```

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

Pass source paths, database path, or refresh timing as options.

```ts
await query("SELECT count(*) FROM messages", {
  refreshIntervalMs: 300_000,
});
```

Run the MCP server over stdio when connecting Tracepond to an agent.

```sh
tracepond mcp
```

The MCP server exposes only two tools.

```text
query     Run read-only DuckDB SQL
describe  Show config, schemas, and examples
```

Tracepond reads these local trace sources.

```text
Codex        ~/.codex/sessions/**/*.jsonl
Claude Code  ~/.claude/projects/**/*.jsonl
Claude Code  ~/.claude/history.jsonl
Cursor       ~/.cursor/chats/*/*/store.db
OpenCode     ~/.local/share/opencode/storage/session/**/*.json
OpenCode     ~/.local/share/opencode/storage/message/**/*.json
```

The storage policy is intentionally fixed.

```text
bronze  views over raw source files/stores
silver  views over bronze
gold    materialized tables
search  DuckDB FTS indexes on gold tables
```

Gold tables are the stable query surface.

```text
messages
conversations
tool_calls
```

FTS indexes are created directly on gold tables.

```text
messages       fts_main_messages.match_bm25(message_key, 'query')
tool_calls     fts_main_tool_calls.match_bm25(tool_call_key, 'query')
conversations  fts_main_conversations.match_bm25(conversation_key, 'query')
```

Gold tables refresh every 5 minutes by default.

```sh
tracepond --refresh-interval 5m describe
```

Configuration stays limited to paths and refresh timing.

```text
--codex-home             TRACEPOND_CODEX_HOME          ~/.codex
--claude-home            TRACEPOND_CLAUDE_HOME         ~/.claude
--cursor-home            TRACEPOND_CURSOR_HOME         ~/.cursor
--opencode-data-dir      TRACEPOND_OPENCODE_DATA_DIRS  ~/.local/share/opencode
--database-path          TRACEPOND_DATABASE_PATH       ~/.tracepond/tracepond.duckdb
--refresh-interval       TRACEPOND_REFRESH_INTERVAL    5m
```

Use standard duration strings for refresh intervals.

```text
0
30s
5m
1h
1d
```

Develop locally with npm.

```sh
npm install
npm run check
npm run build
npm run smoke
```

License is MIT.

```text
MIT
```
