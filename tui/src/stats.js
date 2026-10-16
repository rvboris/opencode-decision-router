import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parseRouterLine } from './format.js';

const emptySummary = () => ({ total: 0, successful: 0, fallback: 0, models: [], profiles: [], agents: [] });
const percent = (count, total) => total ? Math.round((count / total) * 1000) / 10 : 0;
const profileName = entry => `${entry.choice}/${typeof entry.effort === 'string' && entry.effort ? entry.effort : 'effort не указан'}`;

function createAccumulator() {
  const state = { total: 0, successful: 0, fallback: 0, models: new Map(), profiles: new Map(), agents: new Map() };
  return {
    add(entry) {
      state.total++;
      if (!entry.routed) { state.fallback++; return; }
      state.successful++;
      const profile = profileName(entry);
      state.models.set(entry.choice, (state.models.get(entry.choice) ?? 0) + 1);
      state.profiles.set(profile, (state.profiles.get(profile) ?? 0) + 1);
      const agent = typeof entry.agent === 'string' && entry.agent.trim() ? entry.agent : 'неизвестно';
      let stats = state.agents.get(agent);
      if (!stats) state.agents.set(agent, stats = { count: 0, profiles: new Map() });
      stats.count++;
      stats.profiles.set(profile, (stats.profiles.get(profile) ?? 0) + 1);
    },
    result() {
      return {
        total: state.total, successful: state.successful, fallback: state.fallback,
        models: [...state.models].map(([name, count]) => ({ name, count, percent: percent(count, state.successful) })),
        profiles: [...state.profiles].map(([name, count]) => ({ name, count, percent: percent(count, state.successful) })),
        agents: [...state.agents].map(([name, stats]) => ({
          name, count: stats.count, percent: percent(stats.count, state.successful),
          profiles: [...stats.profiles].map(([name, count]) => ({ name, count, percent: percent(count, stats.count) })),
        })),
      };
    },
  };
}

/** Aggregate decision records using the same counters as the streaming reader. */
export function aggregateRouterStats(entries) {
  const accumulator = createAccumulator();
  for (const entry of entries) accumulator.add(entry);
  return accumulator.result();
}

function recognizedLine(line) {
  if (!line.trim()) return { kind: 'empty' };
  let value;
  try { value = JSON.parse(line); } catch { return { kind: 'invalid' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'foreign' };
  // Other JSONL producers may share this file. Only entries with the router's
  // identifying status/reason fields are candidates for router-line parsing.
  if (typeof value.routed !== 'boolean' || typeof value.reason !== 'string') return { kind: 'foreign' };
  const entry = parseRouterLine(line);
  return entry ? { kind: 'entry', entry } : { kind: 'invalid' };
}

function dedupeKey(entry) {
  return typeof entry.sessionID === 'string' && entry.sessionID.length > 0 &&
    typeof entry.eventId === 'string' && entry.eventId.length > 0
    ? `${entry.sessionID}\0${entry.eventId}` : null;
}

/**
 * Read router stats on demand. Injectable fs functions keep I/O errors and
 * streaming behavior unit-testable without exposing paths in returned values.
 */
export async function readRouterStats({ configPath, sessionID, readFileImpl = readFile, createReadStreamImpl = createReadStream } = {}) {
  const empty = emptySummary();
  if (!configPath) return { status: 'off', session: empty, all: empty, invalidLines: 0 };
  let text;
  try { text = await readFileImpl(configPath, 'utf8'); }
  catch (error) {
    return { status: error?.code === 'ENOENT' ? 'config-missing' : 'config-error', session: empty, all: empty, invalidLines: 0 };
  }
  let config;
  try { config = JSON.parse(text); }
  catch { return { status: 'config-error', session: empty, all: empty, invalidLines: 0 }; }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.enabled !== undefined && typeof config.enabled !== 'boolean') ||
      (config.logFile !== undefined && config.logFile !== null && typeof config.logFile !== 'string')) {
    return { status: 'config-error', session: empty, all: empty, invalidLines: 0 };
  }
  if (config.enabled === false) return { status: 'off', session: empty, all: empty, invalidLines: 0 };
  if (typeof config.logFile !== 'string' || !config.logFile.trim()) {
    return { status: 'config-error', session: empty, all: empty, invalidLines: 0 };
  }

  let stream;
  try { stream = createReadStreamImpl(config.logFile, { encoding: 'utf8' }); }
  catch (error) {
    return { status: error?.code === 'ENOENT' ? 'log-missing' : 'log-error', session: empty, all: empty, invalidLines: 0 };
  }
  const all = createAccumulator();
  const session = createAccumulator();
  let invalidLines = 0;
  const seen = new Set();
  try {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      const parsed = recognizedLine(line);
      if (parsed.kind === 'invalid') { invalidLines++; continue; }
      if (parsed.kind !== 'entry') continue;
      const entry = parsed.entry;
      const key = dedupeKey(entry);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      all.add(entry);
      if (typeof sessionID === 'string' && entry.sessionID === sessionID) session.add(entry);
    }
  } catch (error) {
    if (typeof stream.destroy === 'function') stream.destroy();
    return { status: error?.code === 'ENOENT' ? 'log-missing' : 'log-error', session: empty, all: empty, invalidLines };
  }
  return { status: 'ready', session: session.result(), all: all.result(), invalidLines };
}
