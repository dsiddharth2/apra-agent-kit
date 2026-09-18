import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { buildRequest, runHandler, writeNodeResponse, requestSignal } from './router.mjs';

export function createExpressAdapter() {
  let server = null;

  return {
    async start({ routes, port, host, authenticate }) {
      const app = createMcpExpressApp();

      for (const route of Object.values(routes)) {
        if (!route) continue;
        const method = route.method.toLowerCase();
        if (route.raw) {
          app[method](route.path, async (req, res) => {
            const request = buildRequest({ method: req.method, url: req.originalUrl, headers: req.headers, body: req.body ?? null, signal: requestSignal(req, res) });
            const user = route.auth === false ? null : await authenticate(request);
            if (route.auth !== false && !user) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
            req.user = user;
            await route.handler(req, res, user);
          });
          continue;
        }
        app[method](route.path, async (req, res) => {
          const request = buildRequest({ method: req.method, url: req.originalUrl, headers: req.headers, body: req.body ?? null, signal: requestSignal(req, res) });
          request.params = { ...req.params };
          const response = await runHandler(route, request, authenticate);
          await writeNodeResponse(res, response);
        });
      }
      app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

      server = app.listen(port, host);
      await new Promise((resolve, reject) => {
        const onListening = () => { server.off('error', onError); resolve(); };
        const onError = (err) => { server.off('listening', onListening); reject(err); };
        server.once('listening', onListening);
        server.once('error', onError);
      });
    },
    port() { return server?.address()?.port; },
    address() { return server?.address(); },
    async stop() {
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      server = null;
    },
  };
}
