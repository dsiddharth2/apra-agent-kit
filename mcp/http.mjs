import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { authenticate as defaultAuthenticate } from './auth.mjs';

export function createMcpHttpApp({ buildServer, authenticate = defaultAuthenticate, host = '127.0.0.1', allowedHosts } = {}) {
  if (typeof buildServer !== 'function') {
    throw new Error('createMcpHttpApp requires a buildServer function');
  }

  // createMcpExpressApp() parses JSON bodies, so no express.json(). It picks
  // Host header validation (DNS rebinding protection) from the bind host:
  // localhost binds accept only localhost names, 0.0.0.0 binds rely on auth.
  // allowedHosts overrides both (#89).
  const app = createMcpExpressApp({ host, allowedHosts });

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.post('/mcp', authenticate, async (req, res) => {
    // Stateless: a fresh server and transport per request share nothing between
    // concurrent calls, and no MCP session ids are issued.
    const server = buildServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await server.close();
    }
  });

  return app;
}
