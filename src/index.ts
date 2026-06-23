#!/usr/bin/env node
import { Command } from "commander";
import { runMemoryMcpServer } from "./mcp/server.js";
import { formatQueryResult, MemoryDuckDb, type MemoryConfig } from "./memory/duckdb.js";

type CliOptions = {
  codexHome?: string;
  claudeHome?: string;
  cursorHome?: string;
  opencodeDataDir?: string[];
  databasePath?: string;
  workspaceRoot?: string[];
  cwd?: string;
};

const program = new Command()
  .name("tracepond")
  .description("Query local coding-agent traces and memories with DuckDB SQL.")
  .version("0.1.0")
  .showHelpAfterError()
  .option("--codex-home <path>", "Override Codex home, default ~/.codex")
  .option("--claude-home <path>", "Override Claude home, default ~/.claude")
  .option("--cursor-home <path>", "Override Cursor home, default ~/.cursor")
  .option("--opencode-data-dir <path>", "Add an OpenCode data dir; can be repeated, default ~/.local/share/opencode", collect, [])
  .option("--database-path <path>", "Override persistent DuckDB cache path, default ~/.tracepond/tracepond.duckdb")
  .option("--workspace-root <path>", "Add a workspace root; can be repeated", collect, [])
  .option("--cwd <path>", "Override current working directory");

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
    const db = await MemoryDuckDb.open(configFromOptions(program.opts<CliOptions>()));
    try {
      console.log(formatQueryResult(await db.query(sqlParts.join(" "))));
    } finally {
      await db.close();
    }
  });

program
  .command("describe")
  .description("Describe available views and resolved config")
  .action(async () => {
    const db = await MemoryDuckDb.open(configFromOptions(program.opts<CliOptions>()));
    try {
      console.log(await db.describe());
    } finally {
      await db.close();
    }
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
    workspaceRoots: options.workspaceRoot?.length ? options.workspaceRoot : undefined,
  };
}

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
