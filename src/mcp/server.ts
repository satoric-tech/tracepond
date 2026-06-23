import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { describe, formatQueryResult, query as runQuery, type MemoryConfig } from "../sdk.js";

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
        const result = await runQuery(query, config);
        return {
          content: [{ type: "text", text: formatQueryResult(result) }],
        };
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
        return {
          content: [{ type: "text", text: await describe(config) }],
        };
      },
    );
  };

  registerQueryTool("query");
  registerDescribeTool("describe");
  registerQueryTool("tracepond.query");
  registerDescribeTool("tracepond.describe");

  await server.connect(new StdioServerTransport());
}
