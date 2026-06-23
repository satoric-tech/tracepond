# tracepond

[![License](https://img.shields.io/badge/license-MIT-007ec6?style=flat-square)](LICENSE)

DuckDB over local coding-agent traces. Use it as a CLI, TypeScript SDK, or MCP server.

Tracepond gives you stable query surfaces:

| Layer | Tables / views |
|---|---|
| Bronze | `codex_raw`, `claude_raw`, `cursor_raw`, `opencode_raw` |
| Silver | `codex_events`, `claude_events`, `cursor_events`, `opencode_events` |
| Gold | `messages`, `conversations`, `tool_calls`, `search_documents` |
| Control | `source_files`, `memory_documents` |

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

BM25 search in `search` mode:

```sh
tracepond --storage-mode search query "
  SELECT source, kind, substr(text, 1, 160) AS text,
         fts_main_search_documents.match_bm25(document_key, 'deploy') AS score
  FROM search_documents
  WHERE score IS NOT NULL
  ORDER BY score DESC
  LIMIT 10
"
```

Config example:

```sh
tracepond \
  --storage-mode cache \
  --bronze-mode table \
  --silver-mode view \
  --gold-mode view \
  --search off \
  --refresh-interval 5m \
  describe
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
  storageMode: "cache",
  bronzeMode: "table",
  silverMode: "view",
  goldMode: "view",
  searchMode: "off",
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
| Codex | `~/.codex/sessions/**/*.jsonl`, `~/.codex/memories/**`, `~/.codex/memories_extensions/**` |
| Claude Code | `~/.claude/projects/**/*.jsonl`, `~/.claude/history.jsonl`, `~/.claude/projects/*/memory/**/*.md` |
| Cursor | `~/.cursor/chats/*/*/store.db` |
| OpenCode | `~/.local/share/opencode/storage/session/**/*.json`, `~/.local/share/opencode/storage/message/**/*.json` |
| Workspace | `AGENTS.md`, `CLAUDE.md` |

---

## Storage

Tracepond uses a stable logical model and configurable physical storage.

| Mode | Bronze | Silver | Gold | Search |
|---|---|---|---|---|
| `live` | view | view | view | off |
| `cache` | table | view | view | off |
| `search` | table | view | view | table |
| `fast` | table | table | table | table |

Current support: `cache` and `search`.

The other modes are reserved by the config contract and fail clearly until their physical refresh paths are implemented.

`search` mode materializes `search_documents` and creates a DuckDB FTS index. The query connection remains read-only, but extension loading requires DuckDB external access.

Global table refresh runs as:

```text
bronze -> silver -> gold -> search
```

Views are recreated every startup. Tables are refreshed when the global refresh runs. `--refresh-interval` / `TRACEPOND_REFRESH_INTERVAL` skips table refreshes while the cache is fresh.

---

## Options

| CLI flag | Env var | Default |
|---|---|---|
| `--codex-home` | `TRACEPOND_CODEX_HOME` | `~/.codex` |
| `--claude-home` | `TRACEPOND_CLAUDE_HOME` | `~/.claude` |
| `--cursor-home` | `TRACEPOND_CURSOR_HOME` | `~/.cursor` |
| `--opencode-data-dir` | `TRACEPOND_OPENCODE_DATA_DIRS` | `~/.local/share/opencode` |
| `--database-path` | `TRACEPOND_DATABASE_PATH` | `~/.tracepond/tracepond.duckdb` |
| `--workspace-root` | `TRACEPOND_WORKSPACE_ROOTS` | current directory |
| `--storage-mode` | `TRACEPOND_STORAGE_MODE` | `cache` |
| `--bronze-mode` | `TRACEPOND_BRONZE_MODE` | profile default |
| `--silver-mode` | `TRACEPOND_SILVER_MODE` | profile default |
| `--gold-mode` | `TRACEPOND_GOLD_MODE` | profile default |
| `--search` | `TRACEPOND_SEARCH` | profile default |
| `--refresh-interval` | `TRACEPOND_REFRESH_INTERVAL` | `0` |

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
