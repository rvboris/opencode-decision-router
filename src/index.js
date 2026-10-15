// OpenCode V2 plugin. setup returns idempotent cleanup, matching the installed
// OMO V2 server adapter contract; disposal aborts in-flight classification.
import { loadConfigFromEnv, resolveApiKey } from './config.js';
import { evaluateEvent } from './policy.js';
import { classifyTask, buildDecisionRequest } from './client.js';
import { appendFile } from 'node:fs/promises';

export { loadConfigFile, loadConfigFromEnv, validateConfig, resolveApiKey, parseApiKeyFileContent, ConfigError, DEFAULTS } from './config.js';
export { evaluateEvent, parseModelId, validateDecisionResponse } from './policy.js';
export { classifyTask, buildDecisionRequest, DecisionsRequestError, MAX_RESPONSE_BYTES } from './client.js';

function safeLogLine(logFile, entry) {
  if (!logFile) return;
  try {
    const line = JSON.stringify(entry) + '\n';
    void appendFile(logFile, line).catch(() => {});
  } catch {
    // Serialization or append preparation must never affect routing.
  }
}

export function createRouter(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? (() => Date.now());
  const env = dependencies.env ?? process.env;
  const log = dependencies.log ?? ((entry) => safeLogLine(config.logFile, entry));
  const activeControllers = new Set();
  let disposed = false;

  function emit(entry) {
    try { log(entry); } catch { /* user logger is non-fatal */ }
  }

  async function decide(task) {
    if (disposed) return { choice: null, reason: 'disposed' };
    const key = resolveApiKey(config, env);
    if (!key) return { choice: null, reason: 'no-api-key' };
    const controller = new AbortController();
    activeControllers.add(controller);
    const start = now();
    try {
      // classifyTask's caller signal is combined with its own timeout signal.
      const choice = await classifyTask(config, task, key.key, { fetchImpl, signal: controller.signal });
      return { choice, reason: 'classified', latencyMs: now() - start };
    } catch (e) {
      return {
        choice: null,
        reason: disposed ? 'disposed' : e?.name === 'DecisionsRequestError' ? 'decisions-error' : 'unexpected-error',
        latencyMs: now() - start,
        errorName: e?.name ?? 'Unknown',
      };
    } finally {
      activeControllers.delete(controller);
    }
  }

  async function handleEvent(event) {
    if (disposed) return { routed: false, reason: 'disposed' };
    const evaluation = evaluateEvent(event, config);
    if (evaluation.action !== 'classify') return { routed: false, reason: evaluation.reason };
    const meta = {
      eventId: evaluation.eventId,
      sessionID: evaluation.sessionID,
      agent: evaluation.agent,
      taskChars: evaluation.task.length,
    };
    const outcome = await decide(evaluation.task);
    if (disposed) return { routed: false, reason: 'disposed' };
    if (outcome.choice === null) {
      emit({ ...meta, routed: false, reason: outcome.reason, latencyMs: outcome.latencyMs ?? null });
      return { routed: false, reason: outcome.reason };
    }
    const target = config.models[outcome.choice];
    // Prepare safe metadata/logging before the event mutation. A throwing
    // injected logger must neither block dispatch nor make partial changes.
    const entry = {
      ...meta, routed: true, reason: outcome.reason, choice: outcome.choice,
      model: target, latencyMs: outcome.latencyMs ?? null,
    };
    event.input.model = target;
    emit(entry);
    return { routed: true, choice: outcome.choice, model: target };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const controller of activeControllers) controller.abort();
    activeControllers.clear();
  }

  return { handleEvent, evaluateEvent, config, dispose };
}

export default {
  id: 'decision-router',
  async setup(ctx) {
    let config;
    try {
      config = loadConfigFromEnv(process.env);
    } catch {
      // Config helper errors are deliberately fixed/non-specific here; do not
      // expose property values or file contents through host diagnostics.
      process.stderr.write('[decision-router] routing disabled: invalid configuration\n');
      return;
    }
    if (!config.enabled) return;
    const router = createRouter(config);
    const registration = await ctx.tool.hook('execute.before', async (event) => {
      try { await router.handleEvent(event); } catch { /* fail-open */ }
    });
    // V2 setup returns a cleanup function (also used by OMO's V2 server adapter).
    let cleaned = false;
    return async () => {
      if (cleaned) return;
      cleaned = true;
      router.dispose();
      if (typeof registration === 'function') await registration();
      else if (typeof registration?.dispose === 'function') await registration.dispose();
    };
  },
};
