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

function formatSeconds(latencyMs) {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs)) return null;
  return `${(latencyMs / 1000).toFixed(1)}s`;
}

function formatPercent(confidence) {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  const pct = confidence <= 1 ? confidence * 100 : confidence;
  return `${Math.round(pct)}%`;
}

/**
 * Format the indicator for one session.
 *
 * @param {object|null} entry last matching log entry (or null when none)
 * @param {{enabled?: boolean}} state router enabled state
 * @returns {{ text: string|null, tone: 'ok'|'warn'|'off' }} text null means render nothing
 */
export function formatIndicator(entry, state = {}) {
  if (state.enabled === false) return { text: 'DR off', tone: 'off' };
  if (!entry) return { text: null, tone: 'ok' };
  if (entry.routed) {
    const parts = [formatPercent(entry.confidence), formatSeconds(entry.latencyMs)].filter(Boolean);
    const detail = parts.length ? ` (${parts.join(', ')})` : '';
    return { text: `DR ${entry.choice}→${entry.model}${detail}`, tone: 'ok' };
  }
  const kept = typeof entry.model === 'string' && entry.model.length > 0 ? entry.model : 'model';
  return { text: `DR fallback: keep ${kept} (${entry.reason})`, tone: 'warn' };
}
