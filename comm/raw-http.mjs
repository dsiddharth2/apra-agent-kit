import http from 'node:http';
import { buildRequest, matchRoute, runHandler, writeNodeResponse, requestSignal } from './router.mjs';

const MAX_JSON_BODY_BYTES = 100 * 1024;

function payloadTooLarge() {
  const err = new Error('payload too large');
  err.status = 413;
  return err;
}

async function readJsonBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    req.resume();
    throw payloadTooLarge();
  }
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += Buffer.byteLength(c);
    if (n > MAX_JSON_BODY_BYTES) {
      req.resume();
      throw payloadTooLarge();
    }
    chunks.push(c);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return { __invalidJson: text }; }
}

export function createRawHttpAdapter() {
  let server = null;

  return {
    async start({ routes, port, host, authenticate }) {
      server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const match = matchRoute(routes, req.method, url.pathname);
          if (!match) { await writeNodeResponse(res, { status: 404, body: { ok: false, error: 'not_found' } }); return; }
          const { route, params } = match;
          if (route.raw) {
            const request = buildRequest({ method: req.method, url, headers: req.headers, signal: requestSignal(req, res) });
            const user = route.auth === false ? null : await authenticate(request);
            if (route.auth !== false && !user) { await writeNodeResponse(res, { status: 401, body: { ok: false, error: 'unauthorized' } }); return; }
            req.user = user;
            await route.handler(req, res, user);
            return;
          }
          const body = req.method === 'GET' ? null : await readJsonBody(req);
          if (body?.__invalidJson !== undefined) { await writeNodeResponse(res, { status: 400, body: { ok: false, error: 'invalid_json' } }); return; }
          const request = buildRequest({ method: req.method, url, headers: req.headers, body, signal: requestSignal(req, res) });
          request.params = params;
          await writeNodeResponse(res, await runHandler(route, request, authenticate));
        } catch (err) {
          if (!res.headersSent) {
            const status = err?.status === 413 ? 413 : 500;
            const body = status === 413
              ? { ok: false, error: 'payload_too_large' }
              : { ok: false, error: 'internal_error', message: String(err?.message ?? err) };
            await writeNodeResponse(res, { status, body });
          } else res.end();
        }
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
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
