import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRouterState, createRouterMonitor } from '../../tui/src/read-state.js';
import { formatIndicator } from '../../tui/src/format.js';

const entry = { sessionID: 'a', routed: true, reason: 'classified', choice: 'light', model: 'omniroute/light', latencyMs: 812 };
const fail = (code) => Object.assign(new Error('/private/path secret body'), { code });
const reader = (config, log = '') => async (path) => {
  const value = path === 'config' ? config : log;
  if (value instanceof Error) throw value;
  return value;
};

for (const [name, config, log, status, text, tone] of [
  ['disabled', '{"enabled":false}', '', 'off', 'DR · выкл', 'off'],
  ['missing config', fail('ENOENT'), '', 'config-unreadable', 'DR · конфиг недоступен', 'warn'],
  ['unreadable config', fail('EACCES'), '', 'config-unreadable', 'DR · конфиг недоступен', 'warn'],
  ['invalid JSON', '{secret', '', 'config-invalid', 'DR · ошибка конфига', 'warn'],
  ['null config', 'null', '', 'config-invalid', 'DR · ошибка конфига', 'warn'],
  ['array config', '[]', '', 'config-invalid', 'DR · ошибка конфига', 'warn'],
  ['invalid enabled', '{"enabled":"true"}', '', 'config-invalid', 'DR · ошибка конфига', 'warn'],
  ['missing logFile', '{}', '', 'log-unconfigured', 'DR · лог не задан', 'warn'],
  ['blank logFile', '{"logFile":"  "}', '', 'log-unconfigured', 'DR · лог не задан', 'warn'],
  ['missing log', '{"logFile":"log"}', fail('ENOENT'), 'log-missing', 'DR · ожидание', 'off'],
  ['unreadable log', '{"logFile":"log"}', fail('EACCES'), 'log-unreadable', 'DR · лог недоступен', 'warn'],
  ['empty log', '{"logFile":"log"}', '', 'ready', 'DR · ожидание', 'off'],
  ['foreign session', '{"logFile":"log"}', JSON.stringify({ ...entry, sessionID: 'b' }), 'ready', 'DR · ожидание', 'off'],
  ['malformed lines', '{"logFile":"log"}', '{truncated', 'ready', 'DR · ожидание', 'off'],
]) {
  test(`read state: ${name}`, async () => {
    const state = await readRouterState('config', 'a', reader(config, log));
    assert.equal(state.status, status);
    assert.deepEqual(formatIndicator(state.entry, state), { text, tone });
    // Diagnostics take priority even if a caller still holds an old entry.
    if (status !== 'ready') assert.equal(formatIndicator(entry, state).text, text);
  });
}

test('unset config is off without reading any files', async () => {
  assert.deepEqual(await readRouterState(null, 'a', () => assert.fail('unexpected read')), { status: 'off' });
});

test('successful read selects session and never invents confidence', async () => {
  const state = await readRouterState('config', 'a', reader('{"logFile":"log"}', `${JSON.stringify(entry)}\n{partial`));
  assert.deepEqual(state.entry, entry);
  assert.equal(formatIndicator(state.entry, state).text, 'DR · агент неизвестен → light');
});

test('monitor clears on session switch, rejects stale reads and stops publishing after cleanup', async () => {
  const reads = [];
  const states = [];
  const monitor = createRouterMonitor((session) => new Promise((resolve) => reads.push({ session, resolve })), (state) => states.push(state));
  monitor.setSession('a');
  await monitor.refresh(); // coalesces while a is pending
  assert.equal(reads.length, 1);
  monitor.setSession('b');
  assert.deepEqual(states.at(-1), { status: 'pending' });
  monitor.setSession('a'); // same ID but a new generation
  reads[0].resolve({ status: 'ready', entry: { stale: true } });
  reads[1].resolve({ status: 'ready', entry: { stale: true } });
  await Promise.resolve();
  assert.equal(states.length, 3);
  reads[2].resolve({ status: 'ready', entry });
  await Promise.resolve();
  assert.deepEqual(states.at(-1), { status: 'ready', entry });
  monitor.setSession('c');
  assert.deepEqual(states.at(-1), { status: 'pending' });
  monitor.dispose();
  reads[3].resolve({ status: 'ready', entry });
  await Promise.resolve();
  await monitor.refresh();
  monitor.setSession('d');
  assert.equal(states.length, 5);
  assert.equal(reads.length, 4);
});
