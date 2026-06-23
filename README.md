# tracepond

[![License](https://img.shields.io/badge/license-MIT-007ec6?style=flat-square)](LICENSE)

DuckDB over local coding-agent traces. Use it as a CLI, TypeScript SDK, or MCP server.

Tracepond gives you stable query surfaces:

| Layer | Tables / views |
|---|---|
| Bronze | `codex_raw`, `claude_raw`, `cursor_raw`, `opencode_raw` |
| Silver | `codex_events`, `claude_events`, `cursor_events`, `opencode_events` |
| Gold | `messages`, `conversations`, `tool_calls` |
| Control | `source_files` |

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

## CLI

```sh
tracepond describe
```

```sh
tracepond query "
  SELECT source, ts, role, substr(text, 1, 160) AS text
  FROM messages
  WHERE text ILIKE '%deploy%'
  ORDER BY ts DESC
  LIMIT 10
"
```

```sh
tracepond refresh
```

BM25 search:

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

Config example:

```sh
tracepond --refresh-interval 5m describe
```

---

## SDK

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

With options:

```ts
await query("SELECT count(*) FROM messages", {
  refreshIntervalMs: 300_000,
});
```

---

## MCP

```sh
tracepond mcp
```

| Tool | Description |
|---|---|
| `query` | Run read-only DuckDB SQL |
| `describe` | Show config, schemas, and examples |

---

## Examples

<details open>
<summary>Codex</summary>

Recent messages:

```sql
SELECT ts, role, substr(text, 1, 160) AS text
FROM codex_events
WHERE text IS NOT NULL
ORDER BY ts DESC
LIMIT 10;
```

Tool usage:

```sql
SELECT tool_name, count(*) AS n
FROM codex_events
WHERE tool_name IS NOT NULL
GROUP BY 1
ORDER BY n DESC;
```

</details>

<details>
<summary>Claude Code</summary>

Recent messages:

```sql
SELECT ts, role, substr(text, 1, 160) AS text
FROM claude_events
WHERE text IS NOT NULL
ORDER BY ts DESC
LIMIT 10;
```

Tool usage:

```sql
SELECT tool_name, count(*) AS n
FROM claude_events
WHERE tool_name IS NOT NULL
GROUP BY 1
ORDER BY n DESC;
```

</details>

<details>
<summary>Cursor</summary>

Search chats:

```sql
SELECT session_id, role, substr(text, 1, 160) AS text
FROM cursor_events
WHERE text ILIKE '%deploy%'
LIMIT 10;
```

Tool activity:

```sql
SELECT tool_name, count(*) AS n
FROM cursor_events
WHERE tool_name IS NOT NULL
GROUP BY 1
ORDER BY n DESC;
```

</details>

<details>
<summary>OpenCode</summary>

Recent messages:

```sql
SELECT ts, role, model, substr(text, 1, 160) AS text
FROM opencode_events
WHERE kind = 'message'
ORDER BY ts DESC
LIMIT 10;
```

Sessions:

```sql
SELECT session_id, provider, model
FROM opencode_events
WHERE kind = 'session'
LIMIT 10;
```

</details>

---

## Sources

| Source | Paths |
|---|---|
| Codex | `~/.codex/sessions/**/*.jsonl` |
| Claude Code | `~/.claude/projects/**/*.jsonl`, `~/.claude/history.jsonl` |
| Cursor | `~/.cursor/chats/*/*/store.db` |
| OpenCode | `~/.local/share/opencode/storage/session/**/*.json`, `~/.local/share/opencode/storage/message/**/*.json` |

---

## Storage

Tracepond has one storage policy:

| Layer | Physical form |
|---|---|
| Bronze | views over raw source files/stores |
| Silver | views over bronze |
| Gold | materialized tables |
| Search | DuckDB FTS indexes on gold tables |

Gold tables refresh every 5 minutes by default. `tracepond refresh` forces a refresh. `--refresh-interval` / `TRACEPOND_REFRESH_INTERVAL` changes the minimum refresh interval.

FTS indexes are created directly on gold:

| Gold table | FTS function | Indexed text |
|---|---|---|
| `messages` | `fts_main_messages.match_bm25(message_key, 'query')` | `text` |
| `tool_calls` | `fts_main_tool_calls.match_bm25(tool_call_key, 'query')` | `input_text`, `output_text` |
| `conversations` | `fts_main_conversations.match_bm25(conversation_key, 'query')` | `first_user_text`, `last_text` |

---

## Options

| CLI flag | Env var | Default |
|---|---|---|
| `--codex-home` | `TRACEPOND_CODEX_HOME` | `~/.codex` |
| `--claude-home` | `TRACEPOND_CLAUDE_HOME` | `~/.claude` |
| `--cursor-home` | `TRACEPOND_CURSOR_HOME` | `~/.cursor` |
| `--opencode-data-dir` | `TRACEPOND_OPENCODE_DATA_DIRS` | `~/.local/share/opencode` |
| `--database-path` | `TRACEPOND_DATABASE_PATH` | `~/.tracepond/tracepond.duckdb` |
| `--refresh-interval` | `TRACEPOND_REFRESH_INTERVAL` | `5m` |

Durations: `0`, `30s`, `5m`, `1h`, `1d`.

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

MIT
