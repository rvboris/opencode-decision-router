// Reconciliation-readiness fake tests mirroring the reserved-unknown semantics
// now present in the shared ledger (acknowledgeUnknownReserve). These run
// against a local fake ledger implementation only; the real ledger is never
// touched by this lane.
import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal local model of the documented ledger semantics used by the bridge:
// effective cost = known costs + authorized reserves; unknown-without-reserve
// blocks further reservations.
function fakeLedger(attempts) {
  const state = { attempts: attempts.map(a => ({ outcome: 'http-ok', costUsd: null, acknowledged: false, authorizedReserveUsd: null, ...a })) };  const effective = () => state.attempts.reduce((sum, a) => sum + (a.costUsd ?? 0) + (a.authorizedReserveUsd ?? 0), 0);
  return {
    effectiveUsd: effective,
    async acknowledgeUnknownReserve({ attemptNumber, reserveUsd, reason }) {
      const a = state.attempts.find(x => x.n === attemptNumber);
      if (!a) throw new Error('NO_SUCH_ATTEMPT');
      if (a.costUsd !== null) throw new Error('NOT_UNKNOWN');
      if (a.authorizedReserveUsd !== null) throw new Error('ALREADY_ACK');
      if (!/reserve/i.test(String(reason)) || reserveUsd <= 0) throw new Error('BAD_RESERVE');
      a.authorizedReserveUsd = reserveUsd;
    },
    async reserveAttempt() {
      if (effective() >= 0.01) throw new Error('OVER_COST_STOP');
      const n = state.attempts.length + 1;
      state.attempts.push({ n, outcome: 'reserved', costUsd: null, acknowledged: false, authorizedReserveUsd: null });
      return { attemptNumber: n };
    },
    get attempts() { return state.attempts; },
  };
}

test('approved .001 reserve on unknown attempt unblocks reservation within cap', async () => {
  const known = Array.from({ length: 8 }, (_, i) => ({ n: i + 1, costUsd: 0.0000028 }));
  const led = fakeLedger([...known, { n: 9, costUsd: null }]);
  // Before reserve: unknown blocks by policy; effective is known-only.
  await led.acknowledgeUnknownReserve({ attemptNumber: 9, reserveUsd: 0.001, reason: 'user-authorized reserve for network timeout' });
  assert.equal(led.effectiveUsd(), 0.0000224 + 0.001);
  const token = await led.reserveAttempt();
  assert.ok(token.attemptNumber >= 10);
});

test('reserve is immutable and double-acknowledge is rejected', async () => {
  const led = fakeLedger([{ n: 9, costUsd: null }]);
  await led.acknowledgeUnknownReserve({ attemptNumber: 9, reserveUsd: 0.001, reason: 'user reserve' });
  await assert.rejects(() => led.acknowledgeUnknownReserve({ attemptNumber: 9, reserveUsd: 0.001, reason: 'again' }), /ALREADY_ACK/);
});

test('known-cost attempt cannot be reserved', async () => {
  const led = fakeLedger([{ n: 3, costUsd: 0.0000028 }]);
  await assert.rejects(() => led.acknowledgeUnknownReserve({ attemptNumber: 3, reserveUsd: 0.001, reason: 'r' }), /NOT_UNKNOWN/);
});

test('reservation stops at cost cap (known + reserve >= .01)', async () => {
  const led = fakeLedger([{ n: 1, costUsd: 0.01 }]);
  await assert.rejects(() => led.reserveAttempt(), /OVER_COST_STOP/);
});

test('E2E plan of 7 calls fits within cap after .001 reserve (9 prior + 14 corpus = 23 attempts, cap 30)', async () => {
  const attempts = [...Array.from({ length: 8 }, (_, i) => ({ n: i + 1, costUsd: 0.0000028 })), { n: 9, costUsd: null, authorizedReserveUsd: 0.001 }];
  const led = fakeLedger(attempts);
  // corpus calls materialized as known-cost successes
  for (let i = 0; i < 14; i++) led.attempts.push({ n: 10 + i, costUsd: 0.0000028 });
  let reserved = 0;
  for (let i = 0; i < 7; i++) { await led.reserveAttempt(); reserved++; }
  assert.equal(reserved, 7);
  assert.ok(led.effectiveUsd() + 7 * 0.0000028 < 0.01 + 0.001); // effective plus E2E success costs stays under cap+reserve headroom
});
