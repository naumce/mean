#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NightShiftClient } from "./client.js";
import { createTools } from "./tools.js";

// night-shift-mcp: a stdio MCP server that lets Claude Desktop, Cursor, or
// any other MCP-capable client drive Night Shift with a dispatcher's own
// API key (spec §10, plan Task 5). Stateless — every tool call is exactly
// one (or two, when a load ref or policy name needs resolving first) HTTP
// call to the fleet-backend dispatcher API; nothing here talks to a
// database, and nothing here can take the agent live (see tools.ts).

const baseUrl = process.env.NIGHT_SHIFT_URL;
const apiKey = process.env.NIGHT_SHIFT_API_KEY;

if (!baseUrl || !apiKey) {
  console.error(
    "night-shift-mcp: set NIGHT_SHIFT_URL (e.g. https://your-fleet.example.com/api) and NIGHT_SHIFT_API_KEY " +
      '(from the Night Shift page\'s Settings tab → "New key") before starting this server.',
  );
  process.exit(1);
}

const client = new NightShiftClient({ baseUrl: baseUrl.replace(/\/$/, ""), apiKey });
const tools = createTools(client);

const server = new McpServer({ name: "night-shift-mcp", version: "0.1.0" });

for (const [name, tool] of Object.entries(tools)) {
  server.registerTool(
    name,
    { description: tool.description, inputSchema: tool.inputSchema },
    async (args) => {
      try {
        const result = await tool.handler(args as Record<string, unknown>);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
