---
name: tracepond
description: Use when the user asks about prior work, previous coding-agent sessions, historical tool failures, Cursor chats, OpenCode chats, or decisions that may be recorded in local Codex, Claude Code, Cursor, or OpenCode traces.
---

# Tracepond

Use the `query` MCP tool when the task depends on prior local coding-agent context rather than only the current repository state.

`query` accepts read-only DuckDB SQL, not natural language. Use `describe` first when you need the available view names, schemas, resolved client, or example queries.

Tracepond exposes Codex, Claude Code, Cursor, and OpenCode traces through DuckDB. Bronze views include `codex_raw`, `claude_raw`, `cursor_raw`, and `opencode_raw`; silver event views include `codex_events`, `claude_events`, `cursor_events`, and `opencode_events`; gold tables include `messages`, `conversations`, and `tool_calls`. Use `source_files` to inspect discovered source paths, sizes, mtimes, and ingest timestamps.

Good triggers:

- The user asks what happened before, what was decided, or what a previous session found.
- The user asks about Codex, Claude Code, Cursor, or OpenCode traces.
- The user asks for recurring conventions that may appear in prior agent sessions.
- The user asks whether a similar tool failure, bug, or implementation was seen before.

Prefer focused SQL. Filter by `source` when the user names a specific agent, such as `source = 'claude'` for Claude Code or `source = 'cursor'` for Cursor. Otherwise query gold tables first and narrow to silver event views when source-specific fields are needed.

Use `describe` if you need to know which local sources are available before querying.

Do not dump full transcripts into the conversation. Query for the relevant rows, cite filenames/line numbers, and summarize the conclusion.

Useful tables:

- `source_files`: source manifest with discovered paths, mtimes, and sizes.
- `codex_events`: normalized Codex session events.
- `claude_events`: normalized Claude Code session events.
- `cursor_raw`: raw Cursor `meta` and `blobs` rows from `~/.cursor/chats/*/*/store.db`.
- `cursor_events`: normalized Cursor message/tool events decoded from text-like blob JSON.
- `opencode_events`: normalized OpenCode session/message JSON from `~/.local/share/opencode/storage`.
- `messages`: cross-source normalized message stream.
- `conversations`: cross-source session rollups.
- `tool_calls`: cross-source normalized tool calls and results.
