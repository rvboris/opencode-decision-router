// Real-Decisions bridge for the optional --real-decisions E2E mode.
// Never executed unless --real-decisions AND --ledger are both provided.
// The local proxy accepts the plugin's dummy bearer, reads the real credential
// from the configured apiKeyFile in-process, and forwards ONLY a minimal
// synthetic task body to the real endpoint through the shared budgetedFetch
// ledger. Credentials and prompt bodies are never written to artifacts/logs.
import fs from 'node:fs';
import {parseApiKeyFileContent} from '../../src/config.js';

const ROUTER_TASK_PATTERNS = [/^ROUTER_CASE:\S+\s*/u, /^CHILD_\S+\s*/u, /\bReturn DONE_\S+\.?/u];

export function sanitizeTask(raw) {
  return ROUTER_TASK_PATTERNS.reduce((t, re) => t.replace(re, ''), String(raw ?? '')).trim().slice(0, 4000);
}

export function makeRealBridge({ endpoint, apiKeyFile, budgetedFetchImpl, fetchImpl = fetch, logger = () => {} }) {
  if (!endpoint || !apiKeyFile) throw new Error('real bridge requires endpoint and apiKeyFile');
  let key;
  try {
    key = parseApiKeyFileContent(fs.readFileSync(apiKeyFile, 'utf8'));
  } catch {
    throw new Error('apiKeyFile unreadable');
  }
  if (!key) throw new Error('apiKeyFile empty');
  const budgeted = budgetedFetchImpl(fetchImpl);
  return {
    async handle(requestBody, res) {
      const task = sanitizeTask(requestBody?.state?.task);
      const model = requestBody?.model;
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, state: { task }, questions: requestBody?.questions }),
        signal: AbortSignal.timeout(45000),
        __taskId: 'decision-router-e2e',
        __expected: null,
      };
      let upstream;
      try {
        upstream = await budgeted(endpoint, init);
      } catch (e) {
        logger({ event: 'budget-network-error', name: e.name });
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream-unavailable' }));
        return;
      }
      const text = await upstream.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* malformed upstream */ }
      const usageCost = parsed?.usage && typeof parsed.usage.cost === 'number' ? parsed.usage.cost : null;
      if (!upstream.ok || usageCost === null) {
        // Hard abort per lane policy: missing usage.cost or upstream error must stop the run.
        logger({ event: 'abort', status: upstream.status, hasUsageCost: usageCost !== null, requestId: parsed?.id ?? null });
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'budget-abort', requestId: parsed?.id ?? null }));
        return;
      }
      logger({ event: 'forwarded', status: upstream.status, requestId: parsed?.id ?? null, costUsd: usageCost });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(text);
    },
  };
}
