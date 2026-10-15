import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRouter, default as plugin } from '../../src/index.js';
import { listenOnRandom, readBody, jsonOnce, neverRespond, handle, baseCfg } from './helpers.js';

// Provide the API key env var for the whole router test file; never a real key.
process.env.TEST_KEY = 'unit-test-key';
test.after(() => { delete process.env.TEST_KEY; });

const CONFIG = {
  endpoint: '', // set per-server test
  apiKeyEnv: 'TEST_KEY',
  apiKeyFile: null,
  decisionModel: 'microsoft/microsoft-decision-1',
  models: { light: 'omniroute/light', heavy: 'omniroute/heavy' },
  agents: ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'observer'],
  timeoutMs: 500,
  maxTaskChars: 200,
  logFile: null,
  enabled: true,
};

function evt(inputOverrides = {}, overrides = {}) {
  return {
    tool: 'subagent',
    sessionID: 'ses_parent_1',
    id: 'evt_1',
    input: { agent: 'explorer', prompt: 'find the config parser', description: 'lookup' },
    ...overrides,
    input: { ...{ agent: 'explorer', prompt: 'find the config parser', description: 'lookup' }, ...inputOverrides },
  };
}

async function withDecisionServer(handler, fn) {
  const server = createServer();
  const { port, close } = await listenOnRandom(server);
  jsonOnce(server, handler);
  try {
    return await fn({ ...CONFIG, endpoint: `http://127.0.0.1:${port}/decisions` });
  } finally {
    await close();
  }
}

const OK_LIGHT = (req, res, body) => {
  res.writeHead(200);
  res.end(JSON.stringify({ answers: { routing: { type: 'choice', choice: 'light' } } }));
};
const OK_HEAVY = (req, res, body) => {
  res.writeHead(200);
  res.end(JSON.stringify({ answers: { routing: { type: 'choice', choice: 'heavy' } } }));
};

test('successful classification rewrites only event.input.model', async () => {
  await withDecisionServer(OK_HEAVY, async (cfg) => {
    const r = createRouter(cfg, {});
    const event = evt({ model: 'omniroute/light', prompt: 'architect a new plugin system' });
    const out = await r.handleEvent(event);
    assert.equal(out.routed, true);
    assert.equal(out.choice, 'heavy');
    assert.equal(event.input.model, 'omniroute/heavy');
    // every other arg preserved
    assert.equal(event.input.agent, 'explorer');
    assert.equal(event.input.prompt, 'architect a new plugin system');
    assert.equal(event.input.description, 'lookup');
    assert.equal(event.tool, 'subagent');
    assert.equal(event.sessionID, 'ses_parent_1');
    assert.equal(event.id, 'evt_1');
  });
});

test('light classification replaces the mapped heavy model', async () => {
  await withDecisionServer(OK_LIGHT, async (cfg) => {
    const r = createRouter(cfg, {});
    const event = evt({ model: 'omniroute/heavy#max' });
    const out = await r.handleEvent(event);
    assert.equal(out.routed, true);
    assert.equal(event.input.model, 'omniroute/light');
    assert.equal(event.input.prompt.length > 0, true);
  });
});

test('missing API key fails open, event untouched', async () => {
  await withDecisionServer(OK_LIGHT, async (cfg) => {
    const r = createRouter(cfg, { env: {} });
    const event = evt({});
    const out = await r.handleEvent(event);
    assert.equal(out.routed, false);
    assert.equal(out.reason, 'no-api-key');
    assert.equal(event.input.model, undefined);
  });
});

test('server errors / timeouts / malformed answers fail open, preserve all args', async () => {
  const fail = async (handler) =>
    withDecisionServer(handler, async (cfg) => {
      const r = createRouter(cfg, {});
      const before = JSON.parse(JSON.stringify(evt({ model: 'omniroute/light' })));
      const event = evt({ model: 'omniroute/light' });
      const out = await r.handleEvent(event);
      assert.equal(out.routed, false);
      assert.deepEqual(event, before, 'event must be identical after fallback');
      return out;
    });

  await fail((req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  await fail((req, res) => {
    res.writeHead(200);
    res.end('garbage{');
  });
  await fail((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ answers: { routing: { type: 'choice', choice: 'banana' } } }));
  });

  // timeout
  await (async () => {
    const server = createServer();
    const { port, close } = await listenOnRandom(server);
    neverRespond(server);
    try {
      const r = createRouter({ ...CONFIG, endpoint: `http://127.0.0.1:${port}/d`, timeoutMs: 120 }, {});
      const event = evt({});
      const out = await r.handleEvent(event);
      assert.equal(out.routed, false);
      assert.equal(event.input.model, undefined);
    } finally {
      await close();
    }
  })();
});

test('task text is bounded to maxTaskChars before sending', async () => {
  await withDecisionServer((req, res, body) => {
    const parsed = JSON.parse(body);
    assert.ok(parsed.state.task.length <= 200);
    res.writeHead(200);
    res.end(JSON.stringify({ answers: { routing: { type: 'choice', choice: 'light' } } }));
  }, async (cfg) => {
    const r = createRouter(cfg, {});
    const event = evt({ prompt: 'y'.repeat(5000) });
    const out = await r.handleEvent(event);
    assert.equal(out.routed, true);
  });
});

test('concurrent events are independent: no cross-talk of task/session/model', async () => {
  await (async () => {
    const server = createServer();
    const { port, close } = await listenOnRandom(server);
    const seenTasks = [];
    handle(server, async (req, res) => {
      const body = JSON.parse(await readBody(req));
      seenTasks.push(body.state.task);
      // First request errors, second succeeds heavy, third succeeds light.
      const n = seenTasks.length;
      if (n === 1) {
        res.writeHead(500);
        res.end();
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ answers: { routing: { type: 'choice', choice: n === 2 ? 'heavy' : 'light' } } }));
      }
    });
    try {
      const cfg = { ...CONFIG, endpoint: `http://127.0.0.1:${port}/d` };
      const r = createRouter(cfg, {});
      const e1 = evt({}, { id: 'e1', sessionID: 'p1' });
      e1.input.prompt = 'task one';
      const e2 = evt({}, { id: 'e2', sessionID: 'p2' });
      e2.input.prompt = 'task two';
      const e3 = evt({}, { id: 'e3', sessionID: 'p3' });
      e3.input.prompt = 'task three';
      const results = await Promise.all([r.handleEvent(e1), r.handleEvent(e2), r.handleEvent(e3)]);
      assert.deepEqual(seenTasks.sort(), ['task one', 'task three', 'task two']);
      assert.equal(results[0].routed, false);
      assert.equal(results[1].routed, true);
      assert.equal(e2.input.model, 'omniroute/heavy');
      assert.equal(results[2].routed, true);
      assert.equal(e3.input.model, 'omniroute/light');
      assert.equal(e1.input.model, undefined);
    } finally {
      await close();
    }
  })();
});

test('throwing injected logger does not break dispatch or mutation', async () => {
  await withDecisionServer(OK_LIGHT, async (cfg) => {
    const r = createRouter(cfg, { log: () => { throw new Error('log serialization/backend failure'); } });
    const event = evt({ prompt: 'throwing logger must still route' });
    const out = await r.handleEvent(event);
    assert.equal(out.routed, true);
    assert.equal(event.input.model, 'omniroute/light');
    assert.equal(event.input.prompt, 'throwing logger must still route');
  });
});

test('disposed router is idempotent, aborts pending classification and prevents late mutation', async () => {
  let capturedSignal;
  const r = createRouter(CONFIG, {
    env: { TEST_KEY: 'fake-key' },
    fetchImpl: (_url, init) => {
      capturedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    },
  });
  const event = evt({ model: 'omniroute/light' });
  const pending = r.handleEvent(event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(capturedSignal);
  r.dispose();
  r.dispose();
  const result = await pending;
  assert.equal(capturedSignal.aborted, true);
  assert.equal(result.routed, false);
  assert.equal(result.reason, 'disposed');
  assert.equal(event.input.model, 'omniroute/light');
  assert.equal((await r.handleEvent(evt({}))).reason, 'disposed');
});

test('structured log entries carry metadata only (no prompt, no key, no body)', async () => {
  await withDecisionServer(OK_HEAVY, async (cfg) => {
    const logs = [];
    const r = createRouter(cfg, { log: (e) => logs.push(e) });
    const event = evt({ prompt: 'TOPSECRET-prompt-text' });
    await r.handleEvent(event);
    assert.equal(logs.length, 1);
    const line = JSON.stringify(logs[0]);
    assert.ok(!line.includes('TOPSECRET-prompt-text'));
    assert.equal(logs[0].routed, true);
    assert.equal(logs[0].choice, 'heavy');
    assert.equal(logs[0].model, 'omniroute/heavy');
    assert.equal(typeof logs[0].latencyMs, 'number');
  });
});

test('plugin setup: no env config -> no hook installed', async () => {
  const hooks = [];
  await plugin.setup({
    tool: { hook: async (name, cb) => hooks.push({ name, cb }) },
  });
  assert.equal(hooks.length, 0);
});

test('plugin setup: invalid config file -> no hook installed (fail-safe)', async () => {
  const dir = mkdtemp(join(tmpdir(), 'dr-router-'));
  const p = join(dir, 'bad.json');
  writeFileSync(p, '{broken');
  const hooks = [];
  await plugin.setup({
    tool: { hook: async (name, cb) => hooks.push({ name, cb }) },
  });
  assert.equal(hooks.length, 0);
});

test('plugin setup: enabled config registers execute.before and routes', async () => {
  const hooks = [];
  await withDecisionServer(OK_LIGHT, async (cfg) => {
    const dir = mkdtemp(join(tmpdir(), 'dr-router-'));
    const p = join(dir, 'cfg.json');
    writeFileSync(p, JSON.stringify(cfg));
    const prev = process.env.OPENCODE_DECISION_ROUTER_CONFIG;
    process.env.OPENCODE_DECISION_ROUTER_CONFIG = p;
    const prevKey = process.env.TEST_KEY;
    process.env.TEST_KEY = 'k';
    try {
      const cleanup = await plugin.setup({ tool: { hook: async (name, cb) => { hooks.push({ name, cb }); return { dispose() { hooks[0].disposed = (hooks[0].disposed ?? 0) + 1; } }; } } });
      hooks[0].cleanup = cleanup;
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_DECISION_ROUTER_CONFIG;
      else process.env.OPENCODE_DECISION_ROUTER_CONFIG = prev;
      if (prevKey === undefined) delete process.env.TEST_KEY;
      else process.env.TEST_KEY = prevKey;
    }
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].name, 'execute.before');
    const event = evt({});
    await hooks[0].cb(event);
    assert.equal(event.input.model, 'omniroute/light');
    await hooks[0].cleanup();
    await hooks[0].cleanup();
    assert.equal(hooks[0].disposed, 1);
    const late = evt({});
    await hooks[0].cb(late);
    assert.equal(late.input.model, undefined);
  });
});

test('plugin hook callback never throws (fail-open at the boundary)', async () => {
  const hooks = [];
  await (async () => {
    const server = createServer();
    const { port, close } = await listenOnRandom(server);
    neverRespond(server);
    try {
      const cfg = { ...CONFIG, endpoint: `http://127.0.0.1:${port}/d`, timeoutMs: 80 };
      const dir = mkdtemp(join(tmpdir(), 'dr-router-'));
      const p = join(dir, 'cfg.json');
      writeFileSync(p, JSON.stringify(cfg));
      process.env.OPENCODE_DECISION_ROUTER_CONFIG = p;
      process.env.TEST_KEY = 'k';
      try {
        const cleanup = await plugin.setup({ tool: { hook: async (name, cb) => { hooks.push({ name, cb }); return { dispose() { hooks[0].disposed = (hooks[0].disposed ?? 0) + 1; } }; } } });
      hooks[0].cleanup = cleanup;
      } finally {
        delete process.env.OPENCODE_DECISION_ROUTER_CONFIG;
        delete process.env.TEST_KEY;
      }
      await assert.doesNotReject(() => hooks[0].cb(evt({})));
    } finally {
      await close();
    }
  })();
});

import { mkdtempSync as mkdtemp, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
