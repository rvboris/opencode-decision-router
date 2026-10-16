import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelLines, createPanelLoader } from '../../tui/src/panel-state.js';

const summary = { total: 4, successful: 3, fallback: 1,
  models: [{ name: 'heavy', count: 3, percent: 100 }],
  profiles: [{ name: 'heavy/xhigh', count: 2, percent: 200 / 3 }, { name: 'heavy / effort не указан', count: 1, percent: 100 / 3 }],
  agents: [{ name: 'explorer', count: 3, percent: 100, profiles: [{ name: 'heavy/xhigh', count: 2, percent: 200 / 3 }] }],
};
const empty = { total: 0, successful: 0, fallback: 0, models: [], profiles: [], agents: [] };
const ready = { status: 'ready', session: summary, all: empty, invalidLines: 2 };

test('panel scopes, precise percentages, separate fallback and honest legacy labels', () => {
  const text = panelLines(ready, 'session').join('\n');
  assert.match(text, /Успешно: 3 · fallback: 1/);
  assert.match(text, /heavy\/xhigh — 2 · 66\.7%/);
  assert.match(text, /effort не указан/);
  assert.match(text, /explorer — 3 · 100\.0%/);
  assert.match(text, /внутри агента/);
  assert.match(text, /во всём журнале: 2/);
  assert.match(text, /Пропуски не журналируются/);
  assert.match(text, /только сохранённые записи/);
  assert.match(panelLines(ready, 'all').join('\n'), /Успешных решений пока нет/);
  assert.doesNotMatch(panelLines(ready, 'all').join('\n'), /NaN/);
  assert.match(panelLines(ready, 'session', false)[0], /Нет текущей сессии/);
});

test('panel loading and all diagnostic states are bounded and private', () => {
  for (const status of ['loading', 'off', 'config-missing', 'config-error', 'log-missing', 'log-error', 'unexpected']) {
    const lines = panelLines({ status, error: '/private/secret' }, 'session');
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /secret|private/);
  }
});

test('panel labels cannot inject terminal controls or unbounded strings', () => {
  const text = panelLines({ ...ready, session: { ...summary, models: [{ name: '\x1b\n\u202e' + 'x'.repeat(1000), count: 1, percent: NaN }] } }, 'session').join('\n');
  assert.doesNotMatch(text, /\x1b|\u202e|x{97}|NaN/);
});

test('new refresh/session wins; close prevents late writes', async () => {
  const pending = [], states = [];
  const loader = createPanelLoader((id) => new Promise((resolve) => pending.push({ id, resolve })), (state) => states.push(state));
  const a = loader.refresh('a');
  const b = loader.refresh('b');
  assert.deepEqual(pending.map(x => x.id), ['a', 'b']);
  assert.equal(states.at(-1).status, 'loading');
  pending[1].resolve(ready); await b;
  pending[0].resolve({ status: 'off' }); await a;
  assert.equal(states.at(-1), ready);
  const c = loader.refresh('b');
  loader.dispose();
  pending[2].resolve(ready); await c;
  assert.equal(states.at(-1).status, 'loading');
  await loader.refresh('c');
  assert.equal(pending.length, 3);
});

test('unexpected read failures become generic errors, never unhandled rejections', async () => {
  const states = [];
  const loader = createPanelLoader(async () => { throw Error('secret'); }, s => states.push(s));
  await loader.refresh('a');
  assert.deepEqual(states, [{ status: 'loading' }, { status: 'log-error' }]);
});
