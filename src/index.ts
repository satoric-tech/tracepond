#!/usr/bin/env node
import { Command } from "commander";
import { runMemoryMcpServer } from "./mcp/server.js";
import { parseDurationMs, type MemoryOptions } from "./memory/duckdb.js";
import { describe, formatQueryResult, query, refresh } from "./sdk.js";

type CliOptions = {
  codexHome?: string;
  claudeHome?: string;
  cursorHome?: string;
  opencodeHome?: string;
  tracepondHome?: string;
  cwd?: string;
  refreshInterval?: string;
};

const program = new Command()
  .name("tracepond")
  .description("Query local coding-agent traces with DuckDB SQL.")
  .version("0.1.0")
  .showHelpAfterError()
  .option("--codex-home <path>", "Override Codex home, default ~/.codex")
  .option("--claude-home <path>", "Override Claude home, default ~/.claude")
  .option("--cursor-home <path>", "Override Cursor home, default ~/.cursor")
  .option("--opencode-home <path>", "Override OpenCode home, default ~/.local/share/opencode")
  .option("--tracepond-home <path>", "Override Tracepond home, default ~/.tracepond")
  .option("--cwd <path>", "Override current working directory")
  .option("--refresh-interval <duration>", "Minimum gold/FTS refresh interval, e.g. 0, 30s, 5m, 1h; default 5m");

program
  .command("mcp")
  .description("Run the Tracepond MCP server over stdio")
  .action(async () => {
    await runMemoryMcpServer(configFromOptions(program.opts<CliOptions>()));
  });

program
  .command("query")
  .description("Run read-only DuckDB SQL locally")
  .argument("<sql...>", "Read-only SQL query")
  .action(async (sqlParts: string[]) => {
    const result = await query(sqlParts.join(" "), configFromOptions(program.opts<CliOptions>()));
    console.log(formatQueryResult(result));
  });

program
  .command("describe")
  .description("Describe available views and resolved config")
  .action(async () => {
    console.log(await describe(configFromOptions(program.opts<CliOptions>())));
  });

program
  .command("refresh")
  .description("Force Tracepond to refresh gold tables and FTS indexes")
  .action(async () => {
    await refresh(configFromOptions(program.opts<CliOptions>()));
  });

function configFromOptions(options: CliOptions): MemoryOptions {
  return {
    cwd: options.cwd,
    codexHome: options.codexHome,
    claudeHome: options.claudeHome,
    cursorHome: options.cursorHome,
    opencodeHome: options.opencodeHome,
    tracepondHome: options.tracepondHome,
    refreshIntervalMs: parseDurationMs(options.refreshInterval),
  };
}

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
