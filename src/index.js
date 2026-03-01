import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { startHttpServer } from './httpServer.js';
import { createUniwareMcpServer } from './lib/createUniwareMcpServer.js';

async function startStdioServer() {
  const server = createUniwareMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main() {
  const mode = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();

  if (mode === 'http') {
    await startHttpServer();
    return;
  }

  await startStdioServer();
}

main().catch((error) => {
  console.error('Failed to start Unicommerce MCP server', error);
  process.exit(1);
});
