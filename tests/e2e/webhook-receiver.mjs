import http from 'node:http';

export function startWebhookReceiver({ port = 0, host = '0.0.0.0' } = {}) {
  const received = [];
  const waiters = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      const entry = { headers: req.headers, body: data ? JSON.parse(data) : null, at: Date.now() };
      received.push(entry);
      for (const w of waiters.splice(0)) w(entry);
      res.writeHead(200).end();
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({
    port: server.address().port,
    received,
    waitFor(pred, timeoutMs = 60_000) {
      return new Promise((res, rej) => {
        const hit = received.find(pred);
        if (hit) return res(hit);
        const timer = setTimeout(() => rej(new Error('webhook not received in time')), timeoutMs);
        const waiter = (e) => { if (pred(e)) { clearTimeout(timer); res(e); } else waiters.push(waiter); };
        waiters.push(waiter);
      });
    },
    close: () => new Promise(r => server.close(r)),
  })));
}
