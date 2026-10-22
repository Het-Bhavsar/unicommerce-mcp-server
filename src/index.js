import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { startHttpServer } from './httpServer.js';
import { createUniwareMcpServer } from './lib/createUniwareMcpServer.js';

async function startStdioServer() {
  const server = createUniwareMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function onShutdownSignals(shutdown) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      try {
        await shutdown();
        process.exit(0);
      } catch (error) {
        console.error('Graceful shutdown failed:', error?.message || error);
        process.exit(1);
      }
    });
  }
}

async function main() {
  // Hosted (Railway sets PORT) defaults to http; local default stays stdio.
  const mode = (process.env.MCP_TRANSPORT || (process.env.PORT ? 'http' : 'stdio')).toLowerCase();

  if (mode === 'http') {
    const { close } = await startHttpServer();
    onShutdownSignals(close);
    return;
  }

  await startStdioServer();
}

main().catch((error) => {
  console.error('Failed to start Unicommerce MCP server:', error?.message || error);
  process.exit(1);
});
