import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WebCapAgentService } from './agent/contracts';
import {
  coreToolNames,
  executeCoreTool,
  mcpToolDefinitions,
  parseToolInput,
} from './tool-contracts';

export function createMcpServer(app: WebCapAgentService): McpServer {
  const server = new McpServer({
    name: 'web-cap',
    version: '0.0.1',
  });

  for (const toolName of coreToolNames) {
    const definition = mcpToolDefinitions[toolName];
    server.registerTool(
      toolName,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      async (input) => {
        const parsedInput = parseToolInput(toolName, input);
        const result = await executeCoreTool(app, toolName, parsedInput);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );
  }

  return server;
}
