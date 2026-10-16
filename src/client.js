// Decisions API client. Bounded response handling (64 KiB max), strict answer
// validation, timeout through body consumption, and no body/key in errors.
import { validateDecisionResponse } from './policy.js';

export const MAX_RESPONSE_BYTES = 64 * 1024;

export class DecisionsRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecisionsRequestError';
  }
}

export function buildDecisionRequest(cfg, task) {
  return {
    model: cfg.decisionModel,
    state: { task },
    questions: {
      routing: {
        type: 'choice',
        instructions: cfg.profiles
          ? 'Select one allowed model and effort profile. Prioritize quality: when uncertain choose the stronger appropriate profile, but do not use maximum effort for every task.'
          : 'Select appropriate coding model',
        criteria: cfg.profiles ? Object.fromEntries(Object.entries(cfg.profiles).map(([id, p]) => [id, p.description])) : {
          light: 'Routine bounded edits or lookups with established solution',
          heavy: 'Complex diagnosis, architecture, security-sensitive reasoning or unclear solution',
        },
      },
    },
  };
}

async function cancelBody(body) {
  try {
    if (body && typeof body.cancel === 'function') await body.cancel();
    else if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
  } catch { /* best effort */ }
}

async function readBoundedBody(res, controller) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await cancelBody(res.body);
    controller.abort();
    throw new DecisionsRequestError('decisions response exceeds 64 KiB limit');
  }

  if (!res.body || typeof res.body.getReader !== 'function') {
    // Test doubles/older fetch implementations without streams: still bound
    // after read; production fetch uses a readable byte stream.
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      controller.abort();
      throw new DecisionsRequestError('decisions response exceeds 64 KiB limit');
    }
    return new TextDecoder().decode(bytes);
  }

  const reader = res.body.getReader();
  const abortReader = () => { void reader.cancel().catch(() => {}); };
  controller.signal.addEventListener('abort', abortReader, { once: true });
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          const fail = () => reject(new DecisionsRequestError('decisions request timed out'));
          if (controller.signal.aborted) fail();
          else controller.signal.addEventListener('abort', fail, { once: true });
        }),
      ]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        controller.abort();
        throw new DecisionsRequestError('decisions response exceeds 64 KiB limit');
      }
      chunks.push(value);
    }
  } finally {
    controller.signal.removeEventListener('abort', abortReader);
    try { reader.releaseLock(); } catch {}
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export async function classifyTask(cfg, task, apiKey, { fetchImpl = fetch, signal: parentSignal } = {}) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(buildDecisionRequest(cfg, task)),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (e) {
      const causeMsg = e && e.cause && typeof e.cause.message === 'string' ? e.cause.message : '';
      if (controller.signal.aborted || (e && e.name === 'AbortError')) {
        throw new DecisionsRequestError(parentSignal?.aborted ? 'decisions request aborted' : 'decisions request timed out');
      }
      if (/redirect/i.test(String((e && e.message) || '') + ' ' + causeMsg)) {
        throw new DecisionsRequestError('decisions endpoint attempted a redirect; refusing');
      }
      throw new DecisionsRequestError('decisions request failed (network error)');
    }

    if (res.status < 200 || res.status >= 300) {
      await cancelBody(res.body);
      throw new DecisionsRequestError(`decisions endpoint returned HTTP ${res.status}`);
    }

    let text;
    try {
      text = await readBoundedBody(res, controller);
    } catch (e) {
      if (e instanceof DecisionsRequestError) throw e;
      if (controller.signal.aborted) throw new DecisionsRequestError('decisions request timed out');
      throw new DecisionsRequestError('failed reading decisions response body');
    }
    if (controller.signal.aborted) throw new DecisionsRequestError('decisions request timed out');

    let json;
    try { json = JSON.parse(text); } catch {
      throw new DecisionsRequestError('decisions response is not valid JSON');
    }
    const choice = validateDecisionResponse(json, cfg);
    if (!choice) throw new DecisionsRequestError('decisions response did not contain a valid routing choice');
    return choice;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}
