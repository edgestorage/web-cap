import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connectToDaemon } from './daemon-client';
import { createMcpServer } from './server/mcp-tools';
import type { WebCapAgentService } from './server/agent/contracts';

export async function runMcpServer(
  connect: () => Promise<WebCapAgentService> = connectToDaemon,
): Promise<void> {
  const app = await connect();

  const server = createMcpServer(app);
  const transport = new StdioServerTransport();

  process.on('SIGINT', async () => {
    await app.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await app.close();
    process.exit(0);
  });

  await server.connect(transport);
}
