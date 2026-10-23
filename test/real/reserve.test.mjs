import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initBudget, reserveAttempt, finalizeAttempt, acknowledgeUnknownReserve, budgetStatus } from './ledger.mjs';

test('authorized reserve survives reload, preserves history and cannot be replaced or reset; future unknown blocks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-router-reserve-'));
  const file = join(dir, 'ledger.json');
  await initBudget({ file });
  const token = await reserveAttempt({ file });
  await finalizeAttempt(token, { costUsd: null, outcome: 'network-error' });
  await acknowledgeUnknownReserve({ file, attemptNumber: 1, amountUsd: .001, reason: 'explicit test authorization' });
  const status = await budgetStatus({ file });
  assert.equal(status.attemptCount, 1);
  assert.equal(status.totalCostUsd, 0);
  assert.equal(status.effectiveTotalUsd, .001);
  assert.equal(status.unknown, true);
  assert.equal(status.blockedReason, null);
  const ledger = JSON.parse(await readFile(file));
  assert.equal(ledger.attempts[0].costUsd, null);
  assert.equal(ledger.attempts[0].outcome, 'network-error');
  await assert.rejects(acknowledgeUnknownReserve({ file, attemptNumber: 1, amountUsd: .0001, reason: 'reduce' }), { code: 'ALREADY_ACK' });
  await assert.rejects(initBudget({ file, force: true }), { code: 'ALREADY_INIT' });
  const next = await reserveAttempt({ file });
  await finalizeAttempt(next, { costUsd: null, outcome: 'network-error' });
  await assert.rejects(reserveAttempt({ file }), { code: 'UNKNOWN_BLOCK' });
  assert.equal((await budgetStatus({ file })).attemptCount, 2);
});

test('authorized reserve counts toward cap and requires explicit valid amount/reason/attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-router-reserve-'));
  const file = join(dir, 'ledger.json');
  await initBudget({ file });
  const token = await reserveAttempt({ file });
  await finalizeAttempt(token, { costUsd: null, outcome: 'network-error' });
  await assert.rejects(acknowledgeUnknownReserve({ file, attemptNumber: 1, amountUsd: 0, reason: 'x' }));
  await assert.rejects(acknowledgeUnknownReserve({ file, attemptNumber: 1, amountUsd: .01, reason: '' }));
  await acknowledgeUnknownReserve({ file, attemptNumber: 1, amountUsd: .01, reason: 'test cap authorization' });
  await assert.rejects(reserveAttempt({ file }), { code: 'OVER_COST_STOP' });
  assert.equal((await budgetStatus({ file })).attemptCount, 1);
});
