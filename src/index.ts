#!/usr/bin/env node
import { Command } from "commander";
import { runMemoryMcpServer } from "./mcp/server.js";
import { parseDurationMs } from "./memory/duckdb.js";
import { describe, formatQueryResult, query, refresh, type MemoryConfig } from "./sdk.js";

type CliOptions = {
  codexHome?: string;
  claudeHome?: string;
  cursorHome?: string;
  opencodeDataDir?: string[];
  databasePath?: string;
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
  .option("--opencode-data-dir <path>", "Add an OpenCode data dir; can be repeated, default ~/.local/share/opencode", collect, [])
  .option("--database-path <path>", "Override persistent DuckDB cache path, default ~/.tracepond/tracepond.duckdb")
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
  .description("Force the global bronze-to-silver-to-gold refresh path")
  .action(async () => {
    await refresh(configFromOptions(program.opts<CliOptions>()));
  });

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function configFromOptions(options: CliOptions): Partial<MemoryConfig> {
  return {
    cwd: options.cwd,
    codexHome: options.codexHome,
    claudeHome: options.claudeHome,
    cursorHome: options.cursorHome,
    opencodeDataDirs: options.opencodeDataDir?.length ? options.opencodeDataDir : undefined,
    databasePath: options.databasePath,
    refreshIntervalMs: parseDurationMs(options.refreshInterval),
  };
}

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
