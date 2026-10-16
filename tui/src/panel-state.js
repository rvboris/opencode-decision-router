// Presentation only: aggregation belongs to stats.js.
import { tableRows } from './panel-presentation.js';
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
  const rows = [row('ИТОГ', 'heading'), row(`Успешно: ${summary.successful}`, 'base'),
    row(`Fallback: ${summary.fallback}`, summary.fallback ? 'warning' : 'muted'),
    row('Доли — от успешных решений.')];
  if (!summary.successful) rows.push(row('Успешных решений пока нет.'));
  else {
    const heading = (title) => [row(''), row(title, 'heading')];
    rows.push(...heading('МОДЕЛИ'), ...tableRows(summary.models, width, { bars: true }),
      ...heading('EFFORT · модель / профиль'), ...tableRows(summary.profiles, width), ...heading('АГЕНТЫ'));
    const countWidth = Math.max(1, ...summary.agents.map(agent => String(agent.count).length));
    for (const agent of summary.agents) {
      rows.push(...tableRows([agent], width, { countWidth }), ...tableRows(agent.profiles, width, { indent: '  ', countWidth }));
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
