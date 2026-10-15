import { latestEntryForSession, tailText } from './format.js';

// Injected reader keeps diagnostics testable and never exposes paths/error bodies.
export async function readRouterState(configPath, sessionID, readFile) {
  if (!configPath) return { status: 'off' };
  let text;
  try {
    text = await readFile(configPath, 'utf8');
  } catch {
    return { status: 'config-unreadable' };
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return { status: 'config-invalid' };
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.enabled !== undefined && typeof config.enabled !== 'boolean')) {
    return { status: 'config-invalid' };
  }
  if (config.enabled === false) return { status: 'off' };
  if (typeof config.logFile !== 'string' || !config.logFile.trim()) {
    return { status: 'log-unconfigured' };
  }
  try {
    text = await readFile(config.logFile, 'utf8');
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'log-missing' : 'log-unreadable' };
  }
  return { status: 'ready', entry: latestEntryForSession(tailText(text, 400), sessionID) };
}

// One in-flight read per session generation. Switching clears immediately;
// old reads (including A → B → A) cannot publish into the new generation.
export function createRouterMonitor(read, publish) {
  let sessionID = '';
  let generation = 0;
  let inFlight = null;
  let disposed = false;
  const refresh = async () => {
    if (disposed || inFlight === generation) return;
    const version = generation;
    const session = sessionID;
    inFlight = version;
    try {
      const state = await read(session);
      if (!disposed && version === generation) publish(state);
    } finally {
      if (inFlight === version) inFlight = null;
    }
  };
  return {
    refresh,
    setSession(next) {
      if (disposed || next === sessionID) return;
      sessionID = next;
      generation++;
      publish({ status: 'pending' });
      void refresh();
    },
    dispose() { disposed = true; generation++; },
  };
}
