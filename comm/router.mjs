export function compileRoute(path) {
  const keys = [];
  const pattern = path.replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => { keys.push(k); return '/([^/]+)'; });
  const re = new RegExp(`^${pattern}/?$`);
  return (pathname) => {
    const m = re.exec(pathname);
    if (!m) return null;
    return Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  };
}

export function matchRoute(routes, method, pathname) {
  for (const [name, route] of Object.entries(routes)) {
    if (!route) continue;
    if (route.method !== method) continue;
    const matcher = route._match ?? (route._match = compileRoute(route.path));
    const params = matcher(pathname);
    if (params) return { name, route, params };
  }
  return null;
}

export function parseQuery(search) {
  return Object.fromEntries(new URLSearchParams(search ?? ''));
}

export function lowerHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === 'function' ? headers.entries() : Object.entries(headers);
  for (const [k, v] of entries) out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

export function buildRequest({ method, url, headers, body = null, signal, user = null }) {
  const u = url instanceof URL ? url : new URL(url, 'http://localhost');
  return { method, path: u.pathname, params: {}, query: parseQuery(u.search), headers: lowerHeaders(headers), body, signal, user };
}

export async function runHandler(route, request, authenticate) {
  if (route.auth !== false) {
    const user = await authenticate(request);
    if (!user) return { status: 401, body: { ok: false, error: 'unauthorized' } };
    request.user = user;
  }
  try {
    return await route.handler(request);
  } catch (err) {
    console.error(`[comm] handler error on ${request.method} ${request.path}: ${err?.stack ?? err}`);
    return { status: 500, body: { ok: false, error: 'internal_error', message: String(err?.message ?? err) } };
  }
}

export async function writeNodeResponse(res, response) {
  const headers = { ...(response.headers ?? {}) };
  if (response.stream) {
    if (!headers['content-type']) headers['content-type'] = 'text/event-stream';
    res.writeHead(response.status ?? 200, headers);
    res.flushHeaders?.();
    try {
      for await (const chunk of response.stream) {
        if (res.destroyed) break;
        res.write(chunk);
      }
    } finally {
      res.end();
    }
    return;
  }
  if (typeof response.text === 'string') {
    const payload = Buffer.from(response.text, 'utf8');
    headers['content-type'] = headers['content-type'] ?? 'text/plain; charset=utf-8';
    headers['content-length'] = String(payload.byteLength);
    res.writeHead(response.status ?? 200, headers);
    res.end(payload);
    return;
  }
  const body = response.body === undefined ? '' : JSON.stringify(response.body);
  headers['content-type'] = headers['content-type'] ?? 'application/json';
  res.writeHead(response.status ?? 200, headers);
  res.end(body);
}

// Node req → request.signal that aborts when the client goes away.
export function requestSignal(req, res) {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort(new Error('client disconnected'));
  res.on('close', () => { if (!res.writableFinished) abort(); });
  req.on('aborted', abort);
  return ctrl.signal;
}
