import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { aggregateRouterStats, readRouterStats } from '../../tui/src/stats.js';

const entry = (overrides = {}) => ({ sessionID: 's1', eventId: 'e1', agent: 'fixer', routed: true, reason: 'classified', choice: 'light', model: 'omniroute/light', profile: 'light_medium', effort: 'medium', ...overrides });
const cfg = JSON.stringify({ enabled: true, logFile: 'router.jsonl' });
const response = (log, sessionID = 's1') => readRouterStats({ configPath: 'router.json', sessionID,
  readFileImpl: async path => path === 'router.json' ? cfg : Promise.reject(Object.assign(new Error('private'), { code: 'ENOENT' })),
  createReadStreamImpl: () => Readable.from(log, { encoding: 'utf8' }),
});
const summary = (overrides = {}) => ({ total: 0, successful: 0, fallback: 0, models: [], profiles: [], agents: [], ...overrides });

test('aggregates success profiles and agent-level percentages; fallback excluded from denominator', () => {
  const result = aggregateRouterStats([
    entry(), entry({ eventId: 'e2', choice: 'heavy', profile: 'heavy_xhigh', effort: 'xhigh', agent: 'oracle' }),
    entry({ eventId: 'e3', choice: 'heavy', profile: undefined, effort: undefined }),
    entry({ eventId: 'e4', routed: false, reason: 'no-api-key', choice: undefined, model: undefined }),
  ]);
  assert.deepEqual(result, {
    total: 4, successful: 3, fallback: 1,
    models: [{ name: 'light', count: 1, percent: 33.3 }, { name: 'heavy', count: 2, percent: 66.7 }],
    profiles: [{ name: 'light/medium', count: 1, percent: 33.3 }, { name: 'heavy/xhigh', count: 1, percent: 33.3 }, { name: 'heavy/effort не указан', count: 1, percent: 33.3 }],
    agents: [
      { name: 'fixer', count: 2, percent: 66.7, profiles: [{ name: 'light/medium', count: 1, percent: 50 }, { name: 'heavy/effort не указан', count: 1, percent: 50 }] },
      { name: 'oracle', count: 1, percent: 33.3, profiles: [{ name: 'heavy/xhigh', count: 1, percent: 100 }] },
    ],
  });
});

test('reads the entire log, deduplicates only paired session/event IDs, ignores foreign entries', async () => {
  const rows = Array.from({ length: 450 }, (_, i) => JSON.stringify(entry({ eventId: `e${i}`, choice: i % 2 ? 'light' : 'heavy' })));
  rows.push(JSON.stringify(entry({ eventId: 'e0', choice: 'light' })));
  rows.push(JSON.stringify(entry({ eventId: undefined, choice: 'light' })));
  rows.push(JSON.stringify(entry({ sessionID: 'other', eventId: 'other' })));
  rows.push(JSON.stringify({ unrelated: true }));
  const result = await response(`${rows.join('\n')}\n`);
  assert.equal(result.status, 'ready'); assert.equal(result.invalidLines, 0);
  assert.equal(result.all.total, 452); assert.equal(result.all.successful, 452);
  assert.equal(result.session.total, 451); assert.equal(result.session.models.reduce((n, x) => n + x.count, 0), 451);
});

test('tracks malformed and truncated router lines but ignores other JSON', async () => {
  const result = await response(`${JSON.stringify(entry())}\n{truncated\n${JSON.stringify({ routed: true, reason: 'classified', sessionID: 's1' })}\n${JSON.stringify({ foreign: 1 })}\n`);
  assert.equal(result.status, 'ready'); assert.equal(result.invalidLines, 2); assert.equal(result.all.total, 1);
});

test('legacy decisions display effort not specified and absent agents are honest', () => {
  const result = aggregateRouterStats([entry({ eventId: undefined, profile: undefined, effort: undefined, agent: undefined })]);
  assert.equal(result.profiles[0].name, 'light/effort не указан');
  assert.equal(result.agents[0].name, 'неизвестно');
});

test('empty and session-mismatched logs have zero percentages and empty arrays', async () => {
  assert.deepEqual(await response(''), { status: 'ready', session: summary(), all: summary(), invalidLines: 0 });
  const result = await response(`${JSON.stringify(entry())}\n`, 'absent');
  assert.deepEqual(result.session, summary()); assert.equal(result.all.total, 1);
});

test('configuration and file statuses avoid leaking paths or error bodies', async t => {
  const noSecret = result => assert.doesNotMatch(JSON.stringify(result), /private|secret|router\.jsonl/);
  for (const [name, configPath, readFileImpl, createReadStreamImpl, expected] of [
    ['off', undefined, null, null, 'off'],
    ['missing config', 'router.json', async () => { throw Object.assign(new Error('secret'), { code: 'ENOENT' }); }, null, 'config-missing'],
    ['invalid config', 'router.json', async () => '{secret', null, 'config-error'],
    ['bad config schema', 'router.json', async () => '[]', null, 'config-error'],
    ['disabled', 'router.json', async () => '{"enabled":false}', null, 'off'],
    ['log missing', 'router.json', async () => cfg, () => { throw Object.assign(new Error('private'), { code: 'ENOENT' }); }, 'log-missing'],
    ['log error', 'router.json', async () => cfg, () => { throw new Error('private'); }, 'log-error'],
  ]) {
    await t.test(name, async () => {
      const result = await readRouterStats({ configPath,
        ...(readFileImpl ? { readFileImpl } : {}),
        ...(createReadStreamImpl ? { createReadStreamImpl } : {}),
      });
      assert.equal(result.status, expected); assert.deepEqual(result.all, summary()); noSecret(result);
    });
  }
});

test('stream read errors are reported without leaking error data', async () => {
  const broken = new Readable({ read() { this.destroy(Object.assign(new Error('private secret'), { code: 'EACCES' })); } });
  const result = await readRouterStats({ configPath: 'router.json', readFileImpl: async () => cfg, createReadStreamImpl: () => broken });
  assert.equal(result.status, 'log-error'); assert.equal(result.invalidLines, 0);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|router\.jsonl/);
});
