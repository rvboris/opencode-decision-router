// Ledger unit tests. Fake fetch / temp files only; NO network, NO real keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initBudget,
  reserveAttempt,
  finalizeAttempt,
  budgetStatus,
  budgetedFetch,
  BUDGET,
  BudgetError,
} from './ledger.mjs';

function tmpFile(name) {
  const dir = mkdtempSync(join(tmpdir(), 'dr-ledger-'));
  return join(dir, name);
}

test('ledger is uninitialized until explicit --init-budget', async () => {
  const f = tmpFile('b.json');
  assert.equal((await budgetStatus({ file: f })).initialized, false);
  await assert.rejects(() => reserveAttempt({ file: f }), (e) => e.code === 'NOT_INIT');
  await initBudget({ file: f });
  const s = await budgetStatus({ file: f });
  assert.equal(s.initialized, true);
  assert.equal(s.attemptsRemaining, BUDGET.maxAttempts);
  assert.equal(s.totalCostUsd, 0);
});

test('init refuses to overwrite an existing ledger without force', async () => {
  const f = tmpFile('b.json');
  await initBudget({ file: f });
  await assert.rejects(() => initBudget({ file: f }), (e) => e.code === 'ALREADY_INIT');
});

test('reserve + finalize counts attempts and accumulates known cost', async () => {
  const f = tmpFile('b.json');
  await initBudget({ file: f });
  const t = await reserveAttempt({ file: f });
  assert.equal(t.attemptNumber, 1);
  await finalizeAttempt(t, { taskId: 'T1', expected: 'light', actual: 'light', costUsd: 0.001, outcome: 'http-ok' }, { file: f });
  const s = await budgetStatus({ file: f });
  assert.equal(s.attemptCount, 1);
  assert.equal(s.totalCostUsd, 0.001);
  assert.equal(s.unknown, false);
});

test('cost stop at $0.01 blocks future calls', async () => {
  const f = tmpFile('b.json');
  await initBudget({ file: f });
  for (let i = 0; i < 3; i++) {
    const t = await reserveAttempt({ file: f });
    await finalizeAttempt(t, { taskId: `T${i}`, costUsd: 0.004, outcome: 'http-ok' }, { file: f });
  }
  const s = await budgetStatus({ file: f });
  assert.equal(s.totalCostUsd, 0.012);
  await assert.rejects(() => reserveAttempt({ file: f }), (e) => e.code === 'OVER_COST_STOP');
});

test('attempt cap of 30 (failed included) blocks future calls', async () => {
  const f = tmpFile('b.json');
  await initBudget({ file: f });
  for (let i = 0; i < BUDGET.maxAttempts; i++) {
    const t = await reserveAttempt({ file: f });
    await finalizeAttempt(t, { taskId: `T${i}`, costUsd: 0.0001, outcome: 'http-ok' }, { file: f });
  }
  const s = await budgetStatus({ file: f });
  assert.equal(s.attemptsRemaining, 0);
  await assert.rejects(() => reserveAttempt({ file: f }), (e) => e.code === 'OVER_CAP');
});

test('unknown cost (null) blocks all future calls; also from network errors', async () => {
  const f = tmpFile('b.json');
  await initBudget({ file: f });
  const t = await reserveAttempt({ file: f });
  await finalizeAttempt(t, { taskId: 'T0', costUsd: null, outcome: 'network-error' }, { file: f });
  const s = await budgetStatus({ file: f });
  assert.equal(s.unknown, true);
  assert.match(s.blockedReason, /unknown cost/);
  await assert.rejects(() => reserveAttempt({ file: f }), (e) => e.code === 'UNKNOWN_BLOCK');
});

test('restart with corrupt ledger blocks (LEDGER_CORRUPT), never resets silently', async () => {
  const f = tmpFile('b.json');
  await initBudget({ file: f });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(f, '{broken json');
  await assert.rejects(() => reserveAttempt({ file: f }), (e) => e.code === 'LEDGER_CORRUPT');
});

test('concurrent reserve attempts are rejected (sequential only)', async () => {
  const f = tmpFile('b.json');
  await initBudget({ file: f });
  const first = reserveAttempt({ file: f });
  await assert.rejects(() => reserveAttempt({ file: f }), (e) => e.code === 'CONCURRENT');
  const t = await first;
  await finalizeAttempt(t, { taskId: 'T0', costUsd: 0.0001, outcome: 'http-ok' }, { file: f });
  // sequential reserve works again
  const t2 = await reserveAttempt({ file: f });
  assert.equal(t2.attemptNumber, 2);
  await finalizeAttempt(t2, { taskId: 'T1', costUsd: 0.0001, outcome: 'http-ok' }, { file: f });
});

test('bad costUsd values are rejected at finalize', async () => {
  const f = tmpFile('b.json');
  await initBudget({ file: f });
  const t = await reserveAttempt({ file: f });
  await assert.rejects(
    () => finalizeAttempt(t, { costUsd: -1, outcome: 'x' }, { file: f }),
    (e) => e.code === 'BAD_COST',
  );
  await assert.rejects(
    () => finalizeAttempt(t, { costUsd: 'cheap', outcome: 'x' }, { file: f }),
    (e) => e.code === 'BAD_COST',
  );
});

test('budgetedFetch reserves before network, records usage.cost and request id', async () => {
  const f = tmpFile('b.json');
  await initBudget({ file: f });
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ id: 'req_abc', answers: { routing: { type: 'choice', choice: 'light' } }, usage: { cost: 0.0002 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const wrapped = budgetedFetch(fakeFetch, { file: f });
  const res = await wrapped('https://example.invalid/decisions', {
    method: 'POST',
    headers: { authorization: 'Bearer unit-test-key' },
    body: '{"state":{"task":"SECRET-PROMPT-TEXT"}}',
    __taskId: 'T0',
    __expected: 'light',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.answers.routing.choice, 'light');
  assert.equal(calls.length, 1);
  const s = await budgetStatus({ file: f });
  assert.equal(s.attemptCount, 1);
  assert.equal(s.totalCostUsd, 0.0002);
  assert.equal(s.unknown, false);
  // ledger must not contain the key or the prompt
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(f, 'utf8');
  assert.ok(!raw.includes('unit-test-key'));
  assert.ok(!raw.includes('SECRET-PROMPT-TEXT'));
  assert.ok(raw.includes('req_abc'));
  assert.ok(raw.includes('"taskId": "T0"'));
});

test('budgetedFetch records unknown cost on HTTP error and blocks afterwards', async () => {
  const f = tmpFile('b.json');
  await initBudget({ file: f });
  const fakeFetch = async () => new Response('unauthorized', { status: 401 });
  const wrapped = budgetedFetch(fakeFetch, { file: f });
  const res = await wrapped('https://example.invalid/decisions', { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  await assert.rejects(() => wrapped('https://example.invalid/decisions', { method: 'POST', body: '{}' }),
    (e) => e.code === 'UNKNOWN_BLOCK');
});

test('budgetedFetch propagates network errors, records unknown, blocks', async () => {
  const f = tmpFile('b.json');
  await initBudget({ file: f });
  const fakeFetch = async () => {
    throw new TypeError('fetch failed');
  };
  const wrapped = budgetedFetch(fakeFetch, { file: f });
  await assert.rejects(() => wrapped('https://example.invalid/decisions', { method: 'POST', body: '{}' }), TypeError);
  const s = await budgetStatus({ file: f });
  assert.equal(s.unknown, true);
});
