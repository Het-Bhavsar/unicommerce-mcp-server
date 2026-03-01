import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { createUniwareMcpServer } from './lib/createUniwareMcpServer.js';

function jsonRpcError(res, code, message, status = 400) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null
  });
}

export async function startHttpServer() {
  const host = process.env.MCP_HTTP_HOST || '0.0.0.0';
  const port = Number.parseInt(process.env.MCP_HTTP_PORT || '3000', 10);
  const mcpPath = process.env.MCP_HTTP_PATH || '/mcp';

  const app = createMcpExpressApp({ host });
  const sessions = new Map();

  app.get('/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      name: 'unicommerce-mcp-server',
      transport: 'streamable-http',
      sessions: sessions.size
    });
  });

  app.post(mcpPath, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    try {
      let session = null;

      if (typeof sessionId === 'string' && sessions.has(sessionId)) {
        session = sessions.get(sessionId);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const server = createUniwareMcpServer();
        let transport = null;

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { server, transport });
          }
        });

        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId && sessions.has(closedSessionId)) {
            sessions.delete(closedSessionId);
          }
        };

        transport.onerror = (error) => {
          console.error('MCP stream transport error:', error);
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        jsonRpcError(res, -32000, 'Bad Request: missing valid MCP session or initialize payload', 400);
        return;
      }

      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP POST request:', error);
      if (!res.headersSent) {
        jsonRpcError(res, -32603, 'Internal server error', 500);
      }
    }
  });

  app.get(mcpPath, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing MCP session ID');
      return;
    }

    const session = sessions.get(sessionId);
    await session.transport.handleRequest(req, res);
  });

  app.delete(mcpPath, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing MCP session ID');
      return;
    }

    const session = sessions.get(sessionId);
    await session.transport.handleRequest(req, res);
  });

  const httpServer = app.listen(port, host, () => {
    console.log(`Unicommerce MCP Streamable HTTP server listening on http://${host}:${port}${mcpPath}`);
    console.log('Note: This is a custom Unicommerce MCP server built from Uniware public APIs (no official vendor MCP server).');
  });

  const shutdown = async () => {
    for (const session of sessions.values()) {
      try {
        await session.transport.close();
      } catch (error) {
        console.error('Error closing session transport:', error);
      }
    }
    sessions.clear();

    await new Promise((resolve, reject) => {
      httpServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };

  const handleSignal = (signal) => {
    process.on(signal, async () => {
      try {
        await shutdown();
        process.exit(0);
      } catch (error) {
        console.error('Graceful shutdown failed:', error);
        process.exit(1);
      }
    });
  };

  handleSignal('SIGINT');
  handleSignal('SIGTERM');
}
