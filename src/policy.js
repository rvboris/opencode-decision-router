// Routing policy: pure decision logic over the hook event. No I/O.

// Splits "provider/model" or "provider/model#variant" into parts.
export function parseModelId(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  const hash = model.indexOf('#');
  const base = hash === -1 ? model : model.slice(0, hash);
  const variant = hash === -1 ? null : model.slice(hash + 1);
  if (base.length === 0) return null;
  if (variant !== null && variant.length === 0) return null;
  return { base, variant };
}

/**
 * Decides what to do with a subagent execute.before event, before any network
 * call. Returns one of:
 *   { action: 'skip', reason }        - leave event untouched
 *   { action: 'classify', task }      - call the decisions API; task is the bounded prompt
 * The caller applies the outcome (set input.model) only on a valid response.
 */
export function evaluateEvent(event, cfg) {
  if (!event || typeof event !== 'object') return { action: 'skip', reason: 'no-event' };
  const input = event.input;
  if (!input || typeof input !== 'object') return { action: 'skip', reason: 'no-input' };

  if (event.tool !== 'subagent') return { action: 'skip', reason: 'tool-not-subagent' };

  const agent = typeof input.agent === 'string' ? input.agent : undefined;
  if (!agent || !cfg.agents.includes(agent)) {
    return { action: 'skip', reason: 'agent-not-allowlisted' };
  }

  // Resume of an existing child session keeps its model.
  if (typeof input.sessionID === 'string' && input.sessionID.length > 0) {
    return { action: 'skip', reason: 'resume-session' };
  }

  const parsed = parseModelId(input.model);
  if (parsed) {
    // Explicit model: only re-classify when it is one of the configured pair
    // (any variant of them counts; other variants/models are preserved).
    const mappedBases = new Set(
      (cfg.profiles ? Object.values(cfg.profiles).map(p => p.model) : [cfg.models.light, cfg.models.heavy])
        .map(parseModelId)
        .filter(Boolean)
        .map((id) => id.base),
    );
    if (!mappedBases.has(parsed.base)) {
      return { action: 'skip', reason: 'pinned-model' };
    }
  }
  // Model absent, or explicitly one of the configured pair -> classify.

  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const description = typeof input.description === 'string' ? input.description : '';
  const raw = prompt.length > 0 ? prompt : description;
  if (raw.length === 0) return { action: 'skip', reason: 'no-task-text' };
  const task = raw.length > cfg.maxTaskChars ? raw.slice(0, cfg.maxTaskChars) : raw;

  return { action: 'classify', task, agent, sessionID: event.sessionID ?? null, eventId: event.id ?? null };
}

/**
 * Returns an allowlisted profile ID (profiles mode), legacy light/heavy, or null.
 * Strict: only answers.routing.type === 'choice' with a configured choice.
 */
export function validateDecisionResponse(body, cfg) {
  if (!body || typeof body !== 'object') return null;
  const answers = body.answers;
  if (!answers || typeof answers !== 'object') return null;
  const routing = answers.routing;
  if (!routing || typeof routing !== 'object') return null;
  if (routing.type !== 'choice') return null;
  const choice = routing.choice;
  if (cfg.profiles) {
    return typeof choice === 'string' && Object.hasOwn(cfg.profiles, choice) ? choice : null;
  }
  if (choice !== 'light' && choice !== 'heavy') return null;
  const mapped = cfg.models[choice];
  if (typeof mapped !== 'string' || mapped.length === 0) return null;
  return choice;
}
