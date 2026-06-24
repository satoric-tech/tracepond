#!/usr/bin/env node
import { Command } from "commander";
import { runMemoryMcpServer } from "./mcp/server.js";
import {
  getTracepondConfigPath,
  getTracepondConfigValue,
  setTracepondConfigValue,
  unsetTracepondConfigValue,
  type TracepondConfigFile,
  type TracepondConfigKey,
} from "./memory/duckdb.js";
import { describe, formatQueryResult, query, refresh } from "./sdk.js";

const configKeys = new Set([
  "tracepond.home",
  "codex.home",
  "claude.home",
  "cursor.home",
  "opencode.home",
  "refresh.interval",
]);

const program = new Command()
  .name("tracepond")
  .description("Query local coding-agent traces with DuckDB SQL.")
  .version("0.1.0")
  .showHelpAfterError();

program
  .command("mcp")
  .description("Run the Tracepond MCP server over stdio")
  .action(async () => {
    await runMemoryMcpServer();
  });

program
  .command("query")
  .description("Run read-only DuckDB SQL locally")
  .argument("<sql...>", "Read-only SQL query")
  .action(async (sqlParts: string[]) => {
    const result = await query(sqlParts.join(" "));
    console.log(formatQueryResult(result));
  });

program
  .command("describe")
  .description("Describe available views and resolved config")
  .action(async () => {
    console.log(await describe());
  });

program
  .command("refresh")
  .description("Force Tracepond to refresh gold tables and FTS indexes")
  .action(async () => {
    await refresh();
  });

program
  .command("get")
  .description("Show Tracepond config")
  .argument("[key]", "Config key")
  .action((key?: string) => {
    const parsedKey = key ? parseConfigKey(key) : undefined;
    const value = getTracepondConfigValue(parsedKey);
    console.log(formatConfigValue(value));
  });

program
  .command("set")
  .description("Set a Tracepond config value")
  .argument("<key>", "Config key")
  .argument("<value>", "Config value")
  .action((key: string, value: string) => {
    setTracepondConfigValue(parseConfigKey(key), value);
  });

program
  .command("unset")
  .description("Unset a Tracepond config value")
  .argument("<key>", "Config key")
  .action((key: string) => {
    unsetTracepondConfigValue(parseConfigKey(key));
  });

program
  .command("config-path")
  .description("Print the Tracepond config file path")
  .action(() => {
    console.log(getTracepondConfigPath());
  });

function parseConfigKey(key: string): TracepondConfigKey {
  if (!configKeys.has(key)) {
    throw new Error(`Invalid config key: ${key}. Use one of: ${[...configKeys].join(", ")}`);
  }
  return key as TracepondConfigKey;
}

function formatConfigValue(value: TracepondConfigFile | string | undefined): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
