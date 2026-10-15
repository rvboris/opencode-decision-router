import { once } from 'node:events';

export async function listenOnRandom(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return { port, close: () => new Promise((res) => server.close(res)) };
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Register a handler on the server for all requests.
export function handle(server, fn) {
  server.removeAllListeners('request');
  server.on('request', fn);
}

export function jsonOnce(server, fn) {
  handle(server, async (req, res) => {
    const body = await readBody(req);
    fn(req, res, body);
  });
}

export function neverRespond(server) {
  handle(server, () => {
    /* swallow requests, never reply */
  });
}

export function baseCfg(port, timeoutMs = 500) {
  return {
    endpoint: `http://127.0.0.1:${port}/api/alpha/decisions`,
    decisionModel: 'microsoft/microsoft-decision-1',
    models: { light: 'omniroute/light', heavy: 'omniroute/heavy' },
    timeoutMs,
  };
}
