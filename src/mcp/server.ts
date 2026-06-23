import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatQueryResult, MemoryDuckDb, type MemoryConfig } from "../memory/duckdb.js";

export async function runMemoryMcpServer(config: Partial<MemoryConfig> = {}): Promise<void> {
  const server = new McpServer({
    name: "tracepond",
    version: "0.1.0",
  });

  const registerQueryTool = (name: string) => {
    server.registerTool(
      name,
      {
        title: name,
        description:
          "Run read-only DuckDB SQL over local coding-agent memories, traces, instructions, and prior work.",
        inputSchema: {
          query: z.string().min(1).describe("Read-only DuckDB SQL to run against memory views."),
        },
      },
      async ({ query }) => {
        const db = await MemoryDuckDb.open(config);
        try {
          const result = await db.query(query);
          return {
            content: [{ type: "text", text: formatQueryResult(result) }],
          };
        } finally {
          await db.close();
        }
      },
    );
  };

  const registerDescribeTool = (name: string) => {
    server.registerTool(
      name,
      {
        title: name,
        description: "Describe available DuckDB memory views, schemas, and example queries.",
        inputSchema: {},
      },
      async () => {
        const db = await MemoryDuckDb.open(config);
        try {
          return {
            content: [{ type: "text", text: await db.describe() }],
          };
        } finally {
          await db.close();
        }
      },
    );
  };

  registerQueryTool("query");
  registerDescribeTool("describe");
  registerQueryTool("tracepond.query");
  registerDescribeTool("tracepond.describe");

  await server.connect(new StdioServerTransport());
}
