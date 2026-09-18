// comm/azure-functions/http.mjs
// Azure Functions v4 (Node) HTTP trigger adapter for the neutral comm contract.
// One `app.http()` registration per route. `start()` registers; `stop()` is a
// no-op because the Functions host owns the process. There is no port.
import { Readable } from 'node:stream';
import { runHandler, lowerHeaders } from '../router.mjs';

export const toFunctionsRoute = (path) =>
  path.replace(/^\//, '').replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

export async function toNeutralRequest(req, params = {}, { bodyText } = {}) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  let body = null;
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    if (bodyText !== undefined) {
      try { body = JSON.parse(bodyText); } catch { body = null; }
    } else {
      try { body = await req.json(); } catch { body = null; }
    }
  }
  return {
    method: req.method, path, params: { ...params }, query: Object.fromEntries(url.searchParams),
    headers: lowerHeaders(req.headers), body, signal: req.signal, user: null,
  };
}

export function toHttpResponse(response) {
  const headers = { ...(response.headers ?? {}) };
  if (response.stream) {
    headers['content-type'] = headers['content-type'] ?? 'text/event-stream';
    return { status: response.status ?? 200, headers, body: Readable.from(response.stream) };
  }
  return { status: response.status ?? 200, headers: { 'content-type': 'application/json', ...headers }, jsonBody: response.body ?? {} };
}

async function defaultLoadWebTransport() {
  const { WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/server');
  return WebStandardStreamableHTTPServerTransport;
}

export function createAzureFunctionsAdapter({ app: injectedApp, extraInputs = [], loadWebTransport = defaultLoadWebTransport } = {}) {
  return {
    async start({ routes, authenticate, mcpServerFactory }) {
      const app = injectedApp ?? (await import('@azure/functions')).app;
      app.setup({ enableHttpStream: true });

      for (const [name, route] of Object.entries(routes)) {
        if (!route) continue;
        const common = { methods: [route.method], route: toFunctionsRoute(route.path), authLevel: 'anonymous', extraInputs };

        if (route.raw) {
          app.http(name, {
            ...common,
            handler: async (req) => {
              let bodyText;
              if (req.method !== 'GET' && req.method !== 'DELETE') {
                bodyText = await req.text();
              }
              const request = await toNeutralRequest(req, req.params, { bodyText });
              const user = route.auth === false ? null : await authenticate(request);
              if (route.auth !== false && !user) return toHttpResponse({ status: 401, body: { ok: false, error: 'unauthorized' } });
              if (route.web) return route.web(req, user);
              // MCP on Functions: the SDK's web-standard transport, one server per request.
              const Transport = await loadWebTransport();
              const server = mcpServerFactory();
              const transport = new Transport({ sessionIdGenerator: undefined });
              try {
                await server.connect(transport);
                const webReq = new Request(req.url, { method: req.method, headers: req.headers, body: bodyText });
                const webRes = await transport.handleRequest(webReq);
                return {
                  status: webRes.status,
                  headers: Object.fromEntries(webRes.headers),
                  body: webRes.body ? Readable.fromWeb(webRes.body) : undefined,
                };
              } finally {
                await server.close();
              }
            },
          });
          continue;
        }

        app.http(name, {
          ...common,
          handler: async (req) => {
            const request = await toNeutralRequest(req, req.params);
            return toHttpResponse(await runHandler(route, request, authenticate));
          },
        });
      }
    },
    async stop() {},
    port() { return null; },
    address() { return null; },
  };
}
