// Presentation only: aggregation belongs to stats.js.
import { tableRows, tableGrid, sectionRule, summaryLine } from './panel-presentation.js';
const errors = {
  off: 'Decision Router выключен',
  'config-missing': 'Конфиг не найден',
  'config-error': 'Не удалось прочитать конфиг',
  'log-missing': 'Журнал ещё не создан',
  'log-error': 'Не удалось прочитать журнал',
};
export function panelRows(state, scope, hasSession = true, width = 56) {
  const row = (text, tone = 'muted') => ({ text, tone });
  if (state.status === 'loading') return [row('Загрузка…')];
  if (state.status !== 'ready') return [row(errors[state.status] ?? 'Не удалось прочитать статистику', 'warning')];
  if (scope === 'session' && !hasSession) return [row('Нет текущей сессии. Tab — весь журнал.')];
  const summary = state[scope];
  // One shared grid: the same count/percent/bar columns in every section.
  const gridItems = [...summary.models, ...summary.profiles,
    ...summary.agents, ...summary.agents.flatMap(agent => agent.profiles)];
  const { countWidth } = tableGrid(gridItems.length ? gridItems : [{ count: 0 }], width);
  const rules = { итог: '═', модели: '─', effort: '┄', агенты: '┈' };
  const heading = (title, fill) => [row(''), row(sectionRule(title, fill, width), 'heading')];
  const rows = [];
  rows.push(...heading('ИТОГ', rules.итог),
    row(summaryLine('Успешно', summary.successful, width, countWidth), 'base'),
    row(summaryLine('Fallback', summary.fallback, width, countWidth), summary.fallback ? 'warning' : 'muted'),
    row('Доли — от успешных решений.'));
  if (!summary.successful) rows.push(row('Успешных решений пока нет.'));
  else {
    const items = grid => tableRows(grid.items, width, { countWidth, nameWidth: grid.nameWidth, bar: grid.bar });
    const { nameWidth } = tableGrid(gridItems, width);
    rows.push(...heading('МОДЕЛИ', rules.модели),
      ...items({ items: summary.models, nameWidth, bar: 'model' }),
      ...heading('EFFORT · модель / профиль', rules.effort),
      ...items({ items: summary.profiles, nameWidth, bar: 'effort' }),
      ...heading('АГЕНТЫ', rules.агенты));
    for (const agent of summary.agents) {
      rows.push(...items({ items: [agent], nameWidth, bar: 'agent' }));
      // Sub-profiles: fixed 2-cell indent («└»), columns stay on the grid.
      rows.push(...tableRows(agent.profiles, width, { countWidth, nameWidth, indent: '└', bar: 'effort' }));
    }
    rows.push(row('Доли профилей — внутри агента.'));
  }
  rows.push(row(''), row(`Некорректных строк во всём журнале: ${state.invalidLines}`, state.invalidLines ? 'warning' : 'muted'),
    row('Пропуски не журналируются.'), row('Весь журнал — только сохранённые записи.'),
    row('Это решения, не токены или стоимость.'));
  return rows;
}
export function panelLines(state, scope, hasSession = true, width = 56) {
  return panelRows(state, scope, hasSession, width).map(row => row.text);
}

// A newer refresh/session always wins; disposal prevents late publications.
export function createPanelLoader(read, publish) {
  let version = 0;
  let disposed = false;
  return {
    async refresh(sessionID) {
      if (disposed) return;
      const current = ++version;
      publish({ status: 'loading' });
      let result;
      try { result = await read(sessionID); }
      catch { result = { status: 'log-error' }; }
      if (!disposed && current === version) publish(result);
    },
    dispose() { disposed = true; version++; },
  };
}
