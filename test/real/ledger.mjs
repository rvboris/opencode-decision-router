// Real-API budget ledger (bounded lane). State is normally
// state/real-budget.json (git-ignored), mode 0600, atomic writes.
// Any unknown cost blocks later calls. No prompts or credentials are persisted.
import { open, mkdir, rename, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const BUDGET = Object.freeze({ maxAttempts: 30, costStopUsd: 0.01 });

export class BudgetError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
  }
}

function defaultLedgerPath() {
  return resolve(process.cwd(), 'state', 'real-budget.json');
}

// In-process exclusivity lasts from reservation until finalize. This keeps
// real requests sequential and rejects simultaneous callers.
let locked = false;

async function atomicWriteJson(path, obj) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, path);
  const fh = await open(path, 'r+');
  try { await fh.chmod(0o600); } finally { await fh.close(); }
}

async function readLedger(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new BudgetError(`budget ledger unreadable: ${e.code ?? 'io-error'}`, 'LEDGER_UNREADABLE');
  }
  let json;
  try { json = JSON.parse(text); } catch {
    throw new BudgetError('budget ledger is corrupt (invalid JSON)', 'LEDGER_CORRUPT');
  }
  if (!json || typeof json !== 'object' || !Array.isArray(json.attempts) ||
      typeof json.totalCostUsd !== 'number' || typeof json.attemptCount !== 'number' ||
      typeof json.unknown !== 'boolean') {
    throw new BudgetError('budget ledger is corrupt (bad shape)', 'LEDGER_CORRUPT');
  }
  return json;
}

export async function initBudget({ file = defaultLedgerPath() } = {}) {
  const path = resolve(file);
  if ((await readLedger(path)) !== null) {
    // A ledger with history (attempts or authorized reserves) is never wiped.
    throw new BudgetError('budget ledger already exists; refusing to re-init (history is immutable)', 'ALREADY_INIT');
  }
  await atomicWriteJson(path, {
    version: 1,
    totalCostUsd: 0,
    attemptCount: 0,
    unknown: false,
    blockedReason: null,
    authorizedReserveUsd: 0,
    attempts: [],
  });
  return path;
}

function effectiveTotal(led) {
  return Math.round(((led.totalCostUsd ?? 0) + (led.authorizedReserveUsd ?? 0)) * 1e9) / 1e9;
}

function unacknowledgedUnknowns(led) {
  return led.attempts.filter((a) => a.costUsd === null && !a.acknowledged);
}

/**
 * Explicit operator acknowledgment of ONE unknown-cost attempt with a
 * user-authorized reserve amount and reason. The attempt's cost stays
 * unknown; the reserve counts toward the budget cap. Future unknowns block
 * again. Requires attemptNumber, amountUsd (>0) and reason (non-empty).
 */
export async function acknowledgeUnknownReserve({
  file = defaultLedgerPath(),
  attemptNumber,
  amountUsd,
  reason,
} = {}) {
  const path = resolve(file);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new BudgetError('attemptNumber must be a positive integer', 'BAD_ATTEMPT');
  }
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new BudgetError('amountUsd must be a positive number', 'BAD_AMOUNT');
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new BudgetError('reason must be a non-empty string', 'BAD_REASON');
  }
  const led = await readLedger(path);
  if (led === null) throw new BudgetError('budget ledger not initialized', 'NOT_INIT');
  const idx = led.attempts.findIndex((a) => a.n === attemptNumber);
  if (idx < 0) throw new BudgetError(`attempt ${attemptNumber} not found`, 'NOT_FOUND');
  const attempt = led.attempts[idx];
  if (attempt.costUsd !== null) {
    throw new BudgetError(`attempt ${attemptNumber} has a known cost; no reserve applies`, 'NOT_UNKNOWN');
  }
  if (attempt.acknowledged || attempt.authorizedReserveUsd != null) {
    throw new BudgetError(`attempt ${attemptNumber} already carries an authorized reserve; reserves are immutable`, 'ALREADY_ACK');
  }
  led.attempts[idx] = {
    ...attempt,
    acknowledged: true,
    authorizedReserveUsd: amountUsd,
    acknowledgedReason: reason,
    acknowledgedAt: new Date().toISOString(),
  };
  led.authorizedReserveUsd = Math.round(((led.authorizedReserveUsd ?? 0) + amountUsd) * 1e9) / 1e9;
  const unack = unacknowledgedUnknowns(led);
  led.blockedReason = unack.length
    ? `attempt ${unack[unack.length - 1].n} ended with unknown cost (${unack[unack.length - 1].outcome ?? 'unspecified'})`
    : null;
  await atomicWriteJson(path, led);
  return led;
}

/** Reserve and durably persist the attempt count BEFORE network traffic. */
export async function reserveAttempt({ file = defaultLedgerPath() } = {}) {
  const path = resolve(file);
  if (locked) throw new BudgetError('another attempt is in flight; attempts are sequential', 'CONCURRENT');
  locked = true;
  try {
    const led = await readLedger(path);
    if (led === null) throw new BudgetError('budget ledger not initialized (run with --init-budget)', 'NOT_INIT');
    const unack = unacknowledgedUnknowns(led);
    if (unack.length) throw new BudgetError(`future calls blocked: ${led.blockedReason ?? `attempt ${unack[unack.length - 1].n} ended with unknown cost`}`, 'UNKNOWN_BLOCK');
    const effective = effectiveTotal(led);
    if (effective >= BUDGET.costStopUsd) throw new BudgetError(`cost stop reached: $${effective} (known + authorized reserve) >= $${BUDGET.costStopUsd}`, 'OVER_COST_STOP');
    if (led.attemptCount >= BUDGET.maxAttempts) throw new BudgetError(`attempt cap reached: ${BUDGET.maxAttempts}`, 'OVER_CAP');

    const attemptNumber = led.attemptCount + 1;
    led.attemptCount = attemptNumber; // reservation consumes quota even if process later dies
    led.attempts.push({ n: attemptNumber, taskId: null, expected: null, actual: null, requestId: null, outcome: 'reserved', durationMs: null, costUsd: null, acknowledged: false, authorizedReserveUsd: null });
    await atomicWriteJson(path, led);
    return { attemptNumber, file: path };
  } catch (e) {
    locked = false;
    throw e;
  }
}

/** Finalize the most recent reserved attempt; unknown cost blocks the ledger. */
export async function finalizeAttempt(token, record, { file } = {}) {
  const path = resolve(file ?? token.file);
  try {
    const led = await readLedger(path);
    if (!led) throw new BudgetError('budget ledger not initialized', 'NOT_INIT');
    if (!Number.isInteger(token.attemptNumber) || token.attemptNumber !== led.attemptCount) {
      throw new BudgetError('attempt token is stale or out of order', 'STALE_TOKEN');
    }
    if (record.costUsd !== null && (!Number.isFinite(record.costUsd) || record.costUsd < 0)) {
      throw new BudgetError('costUsd must be a non-negative finite number or null', 'BAD_COST');
    }
    const idx = led.attempts.findIndex((a) => a.n === token.attemptNumber);
    if (idx < 0 || led.attempts[idx].outcome !== 'reserved') throw new BudgetError('attempt is not reserved', 'BAD_TOKEN');
    const unknown = record.costUsd === null;
    const prev = led.attempts[idx];
    led.attempts[idx] = {
      n: token.attemptNumber,
      taskId: record.taskId ?? prev.taskId ?? null,
      expected: record.expected ?? prev.expected ?? null,
      actual: record.actual ?? null,
      requestId: record.requestId ?? null,
      outcome: record.outcome ?? null,
      durationMs: record.durationMs ?? null,
      costUsd: unknown ? null : record.costUsd,
    };
    if (!unknown) led.totalCostUsd = Math.round((led.totalCostUsd + record.costUsd) * 1e9) / 1e9;
    if (unknown) {
      led.unknown = true;
      led.blockedReason = `attempt ${token.attemptNumber} ended with unknown cost (${record.outcome ?? 'unspecified'})`;
    }
    await atomicWriteJson(path, led);
    return led;
  } finally {
    locked = false;
  }
}

export async function budgetStatus({ file = defaultLedgerPath() } = {}) {
  const led = await readLedger(resolve(file));
  if (!led) return { initialized: false };
  return {
    initialized: true,
    attemptCount: led.attemptCount,
    maxAttempts: BUDGET.maxAttempts,
    totalCostUsd: led.totalCostUsd,
    authorizedReserveUsd: led.authorizedReserveUsd ?? 0,
    effectiveTotalUsd: effectiveTotal(led),
    costStopUsd: BUDGET.costStopUsd,
    unknown: led.unknown,
    blockedReason: led.blockedReason,
    unacknowledgedUnknownAttempts: unacknowledgedUnknowns(led).map((a) => a.n),
    attemptsRemaining: Math.max(0, BUDGET.maxAttempts - led.attemptCount),
  };
}

/** Reserve, fetch, capture response usage/request ID, finalize, and return body. */
export function budgetedFetch(fetchImpl = fetch, { file = defaultLedgerPath() } = {}) {
  return async function budgeted(url, init) {
    const token = await reserveAttempt({ file });
    const start = Date.now();
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      await finalizeAttempt(token, {
        taskId: init?.__taskId ?? null,
        expected: init?.__expected ?? null,
        outcome: 'network-error',
        durationMs: Date.now() - start,
        costUsd: null,
      }, { file });
      throw e;
    }
    let text;
    try {
      text = await res.text();
    } catch (e) {
      await finalizeAttempt(token, {
        taskId: init?.__taskId ?? null,
        expected: init?.__expected ?? null,
        outcome: 'body-read-error', durationMs: Date.now() - start, costUsd: null,
      }, { file });
      throw e;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const usageCost = res.ok && parsed?.usage && typeof parsed.usage.cost === 'number' ? parsed.usage.cost : null;
    const requestId = typeof parsed?.id === 'string' ? parsed.id : null;
    await finalizeAttempt(token, {
      taskId: init?.__taskId ?? null,
      expected: init?.__expected ?? null,
      requestId,
      actual: parsed?.answers?.routing?.type === 'choice' && ['light', 'heavy'].includes(parsed.answers.routing.choice) ? parsed.answers.routing.choice : null,
      outcome: res.ok ? 'http-ok' : `http-${res.status}`,
      durationMs: Date.now() - start,
      costUsd: usageCost,
    }, { file });
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
