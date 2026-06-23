---
name: query-tracepond
description: Use when the user asks about prior work, previous agent sessions, recurring repo conventions, historical tool failures, Cursor chats, OpenCode chats, or decisions that may be recorded in local Codex, Claude Code, Cursor, or OpenCode traces.
---

# Query Tracepond

Use the `query` MCP tool when the task depends on prior local coding-agent context rather than only the current repository state.

`query` accepts read-only DuckDB SQL, not natural language. Use `describe` first when you need the available view names, schemas, resolved client, or example queries.

Tracepond exposes Codex, Claude Code, Cursor, and OpenCode traces through DuckDB. Bronze views include `codex_raw`, `claude_raw`, `cursor_raw`, and `opencode_raw`; silver normalized views include `codex_events`, `claude_events`, `cursor_events`, and `opencode_events`; gold tables include `messages`, `conversations`, and `tool_calls`. Use `source_files` to inspect discovered source paths, sizes, mtimes, and ingest timestamps.

Good triggers:

- The user asks what happened before, what was decided, or what a previous session found.
- The user asks about Codex, Claude Code, Cursor, or OpenCode traces/logs.
- The user asks for recurring repo conventions or instructions.
- The user asks whether a similar tool failure, bug, or implementation was seen before.

Prefer focused SQL. Filter by source, event type, payload type, paths, timestamps, tool names, or text search when those are known.

Use `describe` if you need to know which local sources are available before querying.

Do not dump full transcripts into the conversation. Query for the relevant rows, cite filenames/line numbers, and summarize the conclusion.

Useful tables:

- `source_files`: cache manifest and freshness metadata.
- `codex_events`: normalized Codex session events.
- `claude_events`: normalized Claude Code session events.
- `cursor_raw`: raw Cursor `meta` and `blobs` rows from `~/.cursor/chats/*/*/store.db`.
- `cursor_events`: normalized Cursor message/tool events decoded from text-like blob JSON.
- `opencode_events`: normalized OpenCode session/message JSON from `~/.local/share/opencode/storage`.
- `messages`: cross-source normalized message stream.
- `conversations`: cross-source session rollups.
- `tool_calls`: cross-source normalized tool calls and results.
