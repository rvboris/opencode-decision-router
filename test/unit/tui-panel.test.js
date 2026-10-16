import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelLines, panelRows, createPanelLoader } from '../../tui/src/panel-state.js';
import { tableRows, cellWidth, fitLabel, scopeTabs } from '../../tui/src/panel-presentation.js';

const summary = { total: 4, successful: 3, fallback: 1,
  models: [{ name: 'heavy', count: 3, percent: 100 }],
  profiles: [{ name: 'heavy/xhigh', count: 2, percent: 200 / 3 }, { name: 'heavy / effort не указан', count: 1, percent: 100 / 3 }],
  agents: [{ name: 'explorer', count: 3, percent: 100, profiles: [{ name: 'heavy/xhigh', count: 2, percent: 200 / 3 }] }],
};
const empty = { total: 0, successful: 0, fallback: 0, models: [], profiles: [], agents: [] };
const ready = { status: 'ready', session: summary, all: empty, invalidLines: 2 };

test('panel scopes, precise percentages, separate fallback and honest legacy labels', () => {
  const text = panelLines(ready, 'session').join('\n');
  assert.match(text, /Успешно: 3\nFallback: 1/);
  assert.match(text, /heavy\/xhigh\s+2\s+66\.7%/);
  assert.match(text, /effort не указан/);
  assert.match(text, /explorer\s+3\s+100\.0%/);
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

test('tables fit terminal cells, align numeric columns and only graph wide model rows', () => {
  const items = [{ name: 'light', count: 2, percent: 20 }, { name: 'heavy', count: 100, percent: 80 }];
  for (const width of [8, 18, 24, 32, 48, 56]) {
    const rows = tableRows([...items, { name: '界🧭é'.repeat(100), count: 1, percent: 0 }], width, { bars: true });
    for (const row of rows) for (const line of row.text.split('\n')) assert.ok(cellWidth(line) <= width, `${width}: ${line}`);
    assert.equal(rows.some(row => row.text.includes('━')), width >= 48);
  }
  const rows = tableRows(items, 48);
  assert.equal(rows[0].text.indexOf('%'), rows[1].text.indexOf('%'));
  assert.deepEqual(rows.map(row => row.tone), ['light', 'heavy']);
  assert.equal(fitLabel('界界界', 5), '界界…');
  assert.equal(fitLabel('ééé', 2), 'é…');
  const rendered = panelRows(ready, 'session', true, 56);
  assert.equal(rendered.filter(row => row.text.includes('━')).length, 1);
  assert.equal(rendered.find(row => row.text === 'Fallback: 1').tone, 'warning');
  assert.deepEqual(scopeTabs('all', 30).map(tab => tab.active), [false, true]);
  assert.match(scopeTabs('all', 30)[1].text, /^▸/);
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
