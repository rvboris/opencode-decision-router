// Fixture + driver unit tests. Fake fetch only; NO network, NO real keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { CORPUS, LIGHT_FIXTURES, HEAVY_FIXTURES, SMOKE } from './fixtures.mjs';
import { initBudget, budgetStatus } from './ledger.mjs';

const here = new URL('.', import.meta.url).pathname;
const RUNNER = join(here, '..', '..', 'scripts', 'real-validation.mjs');
const { runValidation } = await import(`file://${RUNNER}`);

test('fixtures: 20 corpus tasks, 10 light + 10 heavy, unique ASCII ids and short ASCII text', () => {
  assert.equal(CORPUS.length, 20);
  assert.equal(LIGHT_FIXTURES.length, 10);
  assert.equal(HEAVY_FIXTURES.length, 10);
  const ids = new Set(CORPUS.map((f) => f.id));
  assert.equal(ids.size, 20);
  for (const f of CORPUS) {
    assert.ok(/^[\x20-\x7E]+$/.test(f.task), `task ${f.id} must be printable ASCII`);
    assert.ok(f.task.length <= 200, `task ${f.id} must be short`);
    assert.ok(f.expected === 'light' || f.expected === 'heavy');
  }
  for (const f of LIGHT_FIXTURES) assert.ok(!/architect|security|race|redesign|audit/i.test(f.task));
  for (const f of HEAVY_FIXTURES) assert.ok(!/rename|typo|bump|look up|list the exported/i.test(f.task));
});

test('fixtures: 2 smoke events with known expected choices and valid structure', () => {
  assert.equal(SMOKE.length, 2);
  for (const s of SMOKE) {
    assert.ok(s.expected === 'light' || s.expected === 'heavy');
    assert.equal(s.event.tool, 'subagent');
    assert.ok(typeof s.event.input.prompt === 'string' && s.event.input.prompt.length > 0);
    assert.ok(s.event.input.prompt === s.task);
    assert.ok(CORPUS.some((c) => c.expected === s.expected));
  }
  assert.notEqual(SMOKE[0].expected, SMOKE[1].expected);
});

function writeConfig(dir, overrides = {}) {
  const p = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      enabled: true,
      endpoint: 'https://real.example/alpha/decisions', // fake host; fetch is injected
      apiKeyEnv: 'UNIT_KEY',
      decisionModel: 'microsoft/microsoft-decision-1',
      models: { light: 'omniroute/light', heavy: 'omniroute/heavy' },
      agents: ['explorer', 'oracle'],
      timeoutMs: 500,
      maxTaskChars: 4000,
      logFile: null,
      ...overrides,
    }),
  );
  return p;
}

function fakeDecisionsFetch(expectedMap) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const task = body.state.task;
    const choice = expectedMap(task) ?? 'light';
    return new Response(
      JSON.stringify({ id: `req-${task.slice(0, 8)}`, answers: { routing: { type: 'choice', choice } }, usage: { cost: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

async function freshBudget() {
  const dir = mkdtempSync(join(tmpdir(), 'dr-real-'));
  const f = join(dir, 'budget.json');
  await initBudget({ file: f });
  return f;
}

test('driver preflight: no network without execute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dr-real-'));
  const cfgPath = writeConfig(dir);
  const f = join(dir, 'b.json');
  let network = 0;
  const out = await runValidation({
    configPath: cfgPath,
    budgetFile: f,
    execute: false,
    fetchImpl: async () => {
      network++;
      throw new Error('must not be called');
    },
    log: () => {},
  });
  assert.equal(out.mode, 'preflight');
  assert.equal(network, 0);
});

test('driver smoke+corpus with fake fetch: budget used, matrix produced, results correct', async () => {
  const f = await freshBudget();
  const dir = mkdtempSync(join(tmpdir(), 'dr-real-'));
  const cfgPath = writeConfig(dir);
  process.env.UNIT_KEY = 'fake-unit-token';
  const out = await runValidation({
    configPath: cfgPath,
    budgetFile: f,
    execute: true,
    fetchImpl: fakeDecisionsFetch((task) => (/auth|race|redesign|architect|security|ledger|timeout|mutex|god function|schema/i.test(task) ? 'heavy' : 'light')),
    log: () => {},
  });
  assert.equal(out.mode, 'corpus');
  assert.equal(out.smoke.length, 2);
  assert.equal(out.corpus.length, 20);
  assert.equal(out.confusionMatrix.expectedLight_classifiedHeavy.length, 1);
  assert.equal(out.confusionMatrix.expectedHeavy_classifiedLight.length, 1);
  const s = await budgetStatus({ file: f });
  assert.equal(s.attemptCount, 22); // 2 smoke + 20 corpus, from the SAME shared ledger
  assert.equal(s.unknown, false);
  // results list individual IDs
  assert.deepEqual(out.corpus.map((r) => r.id).sort().slice(0, 4), ['H01', 'H02', 'H03', 'H04']);
});

test('driver aborts real sequence when a smoke result mismatches', async () => {
  const f = await freshBudget();
  const dir = mkdtempSync(join(tmpdir(), 'dr-real-'));
  const cfgPath = writeConfig(dir);
  process.env.UNIT_KEY = 'fake-unit-token';
  // Everything classifies 'heavy': smoke S01 (expected light) must fail.
  await assert.rejects(
    () =>
      runValidation({
        configPath: cfgPath,
        budgetFile: f,
        execute: true,
        fetchImpl: fakeDecisionsFetch(() => 'heavy'),
        log: () => {},
      }),
    /smoke S01 mismatch/,
  );
  const s = await budgetStatus({ file: f });
  assert.ok(s.attemptCount <= 2, 'must abort immediately after the mismatching smoke');
});

test('driver aborts on router fallback (HTTP error from decisions API)', async () => {
  const f = await freshBudget();
  const dir = mkdtempSync(join(tmpdir(), 'dr-real-'));
  const cfgPath = writeConfig(dir);
  process.env.UNIT_KEY = 'fake-unit-token';
  await assert.rejects(
    () =>
      runValidation({
        configPath: cfgPath,
        budgetFile: f,
        execute: true,
        fetchImpl: async () => new Response('boom', { status: 500 }),
        log: () => {},
      }),
    /fell back|aborting real sequence/,
  );
  const s = await budgetStatus({ file: f });
  assert.equal(s.unknown, true, 'HTTP failure is an unknown-cost attempt that blocks the lane');
});

test('driver respects a blocked ledger (no calls after unknown)', async () => {
  const f = await freshBudget();
  const dir = mkdtempSync(join(tmpdir(), 'dr-real-'));
  const cfgPath = writeConfig(dir);
  const { reserveAttempt, finalizeAttempt } = await import(`file://${join(here, 'ledger.mjs')}`);
  const t = await reserveAttempt({ file: f });
  await finalizeAttempt(t, { taskId: 'pre', costUsd: null, outcome: 'network-error' }, { file: f });
  process.env.UNIT_KEY = 'fake-unit-token';
  let network = 0;
  await assert.rejects(
    () =>
      runValidation({
        configPath: cfgPath,
        budgetFile: f,
        execute: true,
        fetchImpl: async () => {
          network++;
          return new Response('{}', { status: 200 });
        },
        log: () => {},
      }),
    /router fallback|blocked/,
  );
  assert.equal(network, 0);
});

test('driver rejects disabled config and missing config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dr-real-'));
  const disabled = writeConfig(dir, { enabled: false });
  await assert.rejects(() => runValidation({ configPath: disabled, execute: true, log: () => {} }), /enabled:false/);
  await assert.rejects(() => runValidation({ configPath: join(dir, 'nope.json'), log: () => {} }), /ConfigError|cannot read|read/i);
});
