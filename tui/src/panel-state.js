// Presentation only: aggregation belongs to stats.js.
const label = (value) => String(value ?? 'не указан').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 96);
const row = (item) => `${label(item.name)} — ${item.count} · ${Number.isFinite(item.percent) ? item.percent.toFixed(1) : '0.0'}%`;
const errors = {
  off: 'Decision Router выключен',
  'config-missing': 'Конфиг не найден',
  'config-error': 'Не удалось прочитать конфиг',
  'log-missing': 'Журнал ещё не создан',
  'log-error': 'Не удалось прочитать журнал',
};
export function panelLines(state, scope, hasSession = true) {
  if (state.status === 'loading') return ['Загрузка…'];
  if (state.status !== 'ready') return [errors[state.status] ?? 'Не удалось прочитать статистику'];
  if (scope === 'session' && !hasSession) return ['Нет текущей сессии. Tab — весь журнал.'];
  const summary = state[scope];
  const lines = [
    `Успешно: ${summary.successful} · fallback: ${summary.fallback}`,
    'Проценты — от успешных решений.',
  ];
  if (!summary.successful) lines.push('Успешных решений пока нет.');
  else {
    lines.push('', 'Модели', ...summary.models.map(row), '', 'Профили · модель / effort', ...summary.profiles.map(row), '', 'Агенты');
    for (const agent of summary.agents) {
      lines.push(row(agent), ...agent.profiles.map((profile) => `  ${row(profile)}`));
    }
    lines.push('  Доли профилей агента — внутри агента.');
  }
  lines.push('', `Некорректных строк во всём журнале: ${state.invalidLines}`,
    'Пропуски не журналируются.', 'Весь журнал — только сохранённые записи.',
    'Это решения, не токены или стоимость.');
  return lines;
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
