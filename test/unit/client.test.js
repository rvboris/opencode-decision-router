import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { classifyTask, buildDecisionRequest, DecisionsRequestError } from '../../src/client.js';
import { listenOnRandom, readBody, jsonOnce, handle, baseCfg } from './helpers.js';

let server; // current test server (one at a time)

async function withServer(setup) {
  server = createServer();
  const { port, close } = await listenOnRandom(server);
  try {
    await setup(baseCfg(port));
  } finally {
    await close();
  }
}

test('buildDecisionRequest matches the decisions contract', () => {
  const cfg = baseCfg(1);
  assert.deepEqual(buildDecisionRequest(cfg, 'the task'), {
    model: 'microsoft/microsoft-decision-1',
    state: { task: 'the task' },
    questions: {
      routing: {
        type: 'choice',
        instructions: 'Select appropriate coding model',
        criteria: {
          light: 'Routine bounded edits or lookups with established solution',
          heavy: 'Complex diagnosis, architecture, security-sensitive reasoning or unclear solution',
        },
      },
    },
  });
});

test('sends bearer auth and contract body; accepts a strict heavy answer', async () => {
  await withServer(async (cfg) => {
    let seen = null;
    jsonOnce(server, (req, res, body) => {
      seen = { auth: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers: { routing: { type: 'choice', choice: 'heavy' } } }));
    });
    const choice = await classifyTask(cfg, 'hard problem', 'sekrit-token', {});
    assert.equal(choice, 'heavy');
    assert.equal(seen.auth, 'Bearer sekrit-token');
    assert.equal(seen.body.model, 'microsoft/microsoft-decision-1');
    assert.deepEqual(seen.body.questions.routing.criteria.heavy,
      'Complex diagnosis, architecture, security-sensitive reasoning or unclear solution');
  });
});

test('HTTP 401/429/5xx rejected without leaking response body', async () => {
  await withServer(async (cfg) => {
    jsonOnce(server, (req, res) => {
      res.writeHead(401);
      res.end('UNAUTHORIZED echo xyzzy-secret');
    });
    await assert.rejects(() => classifyTask(cfg, 't', 'k', {}), (e) => {
      assert.ok(e instanceof DecisionsRequestError);
      assert.match(e.message, /401/);
      assert.ok(!e.message.includes('xyzzy-secret'));
      return true;
    });
  });
  await withServer(async (cfg) => {
    jsonOnce(server, (req, res) => {
      res.writeHead(429);
      res.end('limited');
    });
    await assert.rejects(() => classifyTask(cfg, 't', 'k', {}), /429/);
  });
  await withServer(async (cfg) => {
    jsonOnce(server, (req, res) => {
      res.writeHead(503);
      res.end('boom');
    });
    await assert.rejects(() => classifyTask(cfg, 't', 'k', {}), /503/);
  });
});

test('malformed JSON and invalid decision shapes are rejected', async () => {
  await withServer(async (cfg) => {
    jsonOnce(server, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not json {');
    });
    await assert.rejects(() => classifyTask(cfg, 't', 'k', {}), /not valid JSON/);
  });
  await withServer(async (cfg) => {
    jsonOnce(server, (req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ answers: { routing: { type: 'choice', choice: 'gigachad' } } }));
    });
    await assert.rejects(() => classifyTask(cfg, 't', 'k', {}), /valid routing choice/);
  });
  await withServer(async (cfg) => {
    jsonOnce(server, (req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ answers: { routing: { type: 'text', text: 'light' } } }));
    });
    await assert.rejects(() => classifyTask(cfg, 't', 'k', {}), /valid routing choice/);
  });
});

test('redirects are refused and the key is not forwarded', async () => {
  await withServer(async (cfg) => {
    jsonOnce(server, (req, res) => {
      res.writeHead(302, { location: 'https://evil.example/steal' });
      res.end();
    });
    await assert.rejects(() => classifyTask(cfg, 't', 'k', {}), (e) => {
      assert.match(e.message, /redirect/i);
      return true;
    });
  });
});

test('timeout covers the response body read', async () => {
  await withServer(async (cfg) => {
    handle(server, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      const t = setTimeout(() => {
        try { res.end('"slow"}'); } catch {}
      }, 3000);
      res.on('close', () => clearTimeout(t));
    });
    const start = Date.now();
    await assert.rejects(() => classifyTask({ ...cfg, timeoutMs: 150 }, 't', 'k', {}), /timed out/);
    assert.ok(Date.now() - start < 2000, 'timeout must not wait for the slow body');
  });
});

test('chunked oversized success body is canceled at the 64 KiB cap', async () => {
  const cfg = baseCfg(1, 500);
  let canceled = false;
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() { canceled = true; },
  }), { status: 200 });
  await assert.rejects(() => classifyTask(cfg, 't', 'k', { fetchImpl }), /64 KiB/);
  assert.equal(canceled, true);
});

test('endless non-2xx response body is canceled without waiting for body timeout', async () => {
  const cfg = baseCfg(1, 500);
  let canceled = false;
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('forbidden')); },
    cancel() { canceled = true; },
  }), { status: 503 });
  await assert.rejects(() => classifyTask(cfg, 't', 'k', { fetchImpl }), /503/);
  assert.equal(canceled, true);
});

test('stalled 200 body times out and cancels through full body read', async () => {
  const cfg = baseCfg(1, 120);
  let canceled = false;
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { canceled = true; },
  }));
  await assert.rejects(() => classifyTask(cfg, 't', 'k', { fetchImpl }), /timed out/);
  assert.equal(canceled, true);
});

test('connection refused fails cleanly as a network error', async () => {
  const cfg = baseCfg(1, 250);
  await assert.rejects(() => classifyTask(cfg, 't', 'k', {}), /network error/);
});
