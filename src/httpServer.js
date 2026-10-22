import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { installOAuth } from './auth/oauthServer.js';
import { createUniwareMcpServer } from './lib/createUniwareMcpServer.js';
import { getDefaultUniware } from './lib/uniwareAuth.js';

function jsonRpcError(res, code, message, status = 400) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null
  });
}

export function createHttpApp({
  env = process.env,
  host = '0.0.0.0',
  mcpPath = env.MCP_HTTP_PATH || '/mcp',
  uniware = getDefaultUniware()
} = {}) {
  const teamApiKey = env.TEAM_API_KEY?.trim();
  if (!teamApiKey) {
    throw new Error('TEAM_API_KEY must be set to run the relay in http mode (it guards /mcp).');
  }

  const app = createMcpExpressApp({ host });
  app.disable('x-powered-by');
  const sessions = new Map();

  app.get('/', (_req, res) => {
    res.type('text/plain').send(
      [
        'Unicommerce MCP relay',
        '',
        'Routes:',
        '  GET  /health',
        `  ANY  ${mcpPath}    (Bearer <TEAM_API_KEY> or OAuth access token)`,
        '  GET  /.well-known/oauth-protected-resource',
        '  GET  /.well-known/oauth-authorization-server',
        '  POST /register   /authorize   /token'
      ].join('\n')
    );
  });

  // Public: no secrets, no session counts.
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', uniwareConfigured: uniware.configured });
  });

  const requireAuth = installOAuth(app, {
    teamApiKey,
    signingSecret: env.OAUTH_SIGNING_SECRET?.trim() || undefined,
    mcpPath,
    env
  });

  app.post(mcpPath, requireAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    try {
      let session = null;

      if (typeof sessionId === 'string' && sessions.has(sessionId)) {
        session = sessions.get(sessionId);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const server = createUniwareMcpServer({ uniware });
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
          console.error('MCP stream transport error:', error?.message || error);
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
      console.error('Error handling MCP POST request:', error?.message || error);
      if (!res.headersSent) {
        jsonRpcError(res, -32603, 'Internal server error', 500);
      }
    }
  });

  const handleSessionRequest = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing MCP session ID');
      return;
    }

    const session = sessions.get(sessionId);
    await session.transport.handleRequest(req, res);
  };

  app.get(mcpPath, requireAuth, handleSessionRequest);
  app.delete(mcpPath, requireAuth, handleSessionRequest);

  const closeSessions = async () => {
    for (const session of sessions.values()) {
      try {
        await session.transport.close();
      } catch (error) {
        console.error('Error closing session transport:', error?.message || error);
      }
    }
    sessions.clear();
  };

  return { app, mcpPath, closeSessions };
}

/**
 * Start the relay. Resolves once listening; returns `{ httpServer, port, close }`.
 * Port: PORT (Railway) > MCP_HTTP_PORT > 3000. Host: MCP_HTTP_HOST or 0.0.0.0.
 */
export async function startHttpServer({ env = process.env, port, host, uniware } = {}) {
  const resolvedHost = host ?? env.MCP_HTTP_HOST ?? '0.0.0.0';
  const resolvedPort = port ?? Number.parseInt(env.PORT || env.MCP_HTTP_PORT || '3000', 10);
  const { app, mcpPath, closeSessions } = createHttpApp({ env, host: resolvedHost, uniware });

  const httpServer = await new Promise((resolve, reject) => {
    const server = app.listen(resolvedPort, resolvedHost, () => resolve(server));
    server.on('error', reject);
  });
  const actualPort = httpServer.address().port;
  console.log(`Unicommerce MCP relay listening on http://${resolvedHost}:${actualPort}${mcpPath}`);

  const close = async () => {
    await closeSessions();
    httpServer.closeAllConnections?.();
    await new Promise((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  };

  return { httpServer, port: actualPort, close };
}
