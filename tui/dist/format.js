// Pure logic for the TUI routing indicator: parses Decision Router jsonl log
// lines and formats the footer status text. No JSX, no I/O, no reactive code —
// fully unit-testable. Mirrors src/index.js emit format:
//   { eventId, sessionID, agent, taskChars, routed, reason, choice?, model?, latencyMs? }

/**
 * Parse a single jsonl line into a routing log entry, or return null for
 * anything that is not a routing entry (malformed, truncated, foreign).
 */
export function parseRouterLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.sessionID !== 'string' || value.sessionID.length === 0) return null;
  if (typeof value.routed !== 'boolean') return null;
  if (typeof value.reason !== 'string' || value.reason.length === 0) return null;
  if (value.routed) {
    if (typeof value.choice !== 'string' || value.choice.length === 0) return null;
    if (typeof value.model !== 'string' || value.model.length === 0) return null;
  }
  if (value.latencyMs !== undefined && value.latencyMs !== null && typeof value.latencyMs !== 'number') return null;
  return value;
}

/**
 * Return the last entry in a jsonl text matching sessionID, or null.
 * Malformed lines are skipped.
 */
export function latestEntryForSession(text, sessionID) {
  if (typeof text !== 'string' || !sessionID) return null;
  let latest = null;
  for (const line of text.split('\n')) {
    const entry = parseRouterLine(line);
    if (entry && entry.sessionID === sessionID) latest = entry;
  }
  return latest;
}

/**
 * Read only the tail of the log file to keep refreshes cheap. Returns a string.
 */
export function tailText(text, maxLines = 200) {
  if (typeof text !== 'string') return '';
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

/**
 * Format the indicator for one session.
 *
 * @param {object|null} entry last matching log entry (or null when none)
 * @param {{enabled?: boolean, status?: string}} state local config/log read state
 * @returns {{ text: string, tone: 'ok'|'warn'|'off' }} always-visible status
 */
export function formatIndicator(entry, state = {}) {
  if (state.enabled === false) return { text: 'DR · выкл', tone: 'off' };
  const statuses = {
    off: ['DR · выкл', 'off'],
    pending: ['DR · ожидание', 'off'],
    'config-unreadable': ['DR · конфиг недоступен', 'warn'],
    'config-invalid': ['DR · ошибка конфига', 'warn'],
    'log-unconfigured': ['DR · лог не задан', 'warn'],
    'log-missing': ['DR · ожидание', 'off'],
    'log-unreadable': ['DR · лог недоступен', 'warn'],
  };
  const diagnostic = statuses[state.status];
  if (diagnostic) return { text: diagnostic[0], tone: diagnostic[1] };
  if (!entry) return { text: 'DR · ожидание', tone: 'off' };
  // Older entries may omit the agent. Never infer it from the model or session.
  const agent = typeof entry.agent === 'string' && entry.agent.trim()
    ? entry.agent.trim() : 'агент неизвестен';
  if (entry.routed) {
    return { text: `DR · ${agent} → ${entry.choice}`, tone: 'ok' };
  }
  return { text: `DR · ${agent} · fallback`, tone: 'warn' };
}
