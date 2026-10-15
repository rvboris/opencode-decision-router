#!/usr/bin/env node
// Bounded real Decisions API validation runner. Does NOT run real workers or
// launch actual OpenCode child sessions. It verifies real classification and
// the production createRouter().handleEvent() model mutation using the
// configured (mock-mapping) target model IDs.
//
// No network calls without explicit --execute. Do not execute until parent
// approval after mock integration. Limits: 30 attempts total incl failures;
// cost stop $0.01 (no server guarantee; user accepts up to $0.05); unknown
// usage.cost blocks future calls. Sequential only. Ledger is ignored
// state/real-budget.json, mode 0600, atomic. No prompts/keys persisted.
//
// Usage:
//   node scripts/real-validation.mjs --init-budget
//   node scripts/real-validation.mjs --config /abs/config.json [--budget-file /abs/ledger.json] [--status]
//   node scripts/real-validation.mjs --config /abs/config.json --execute [--smoke-only|--corpus-only]
// Config key source is config.apiKeyEnv or config.apiKeyFile (e.g. supplied
// as a CLI-created config path to /home/boris/Downloads/decider.txt). This
// script never reads, prints, or copies the key.
// First two smoke events must match expected choices or corpus aborts. Corpus
// is 20 fixed synthetic ASCII tasks (10 light/10 heavy); report is descriptive,
// not a calibration claim. Integration lane may import runValidation() and
// reuse the same ledger to share the global 30/$0.01 allowance.

import { createRouter, loadConfigFile, ConfigError } from '../src/index.js';
import { initBudget, budgetStatus, budgetedFetch, acknowledgeUnknownReserve, BUDGET, BudgetError } from '../test/real/ledger.mjs';
import { CORPUS, SMOKE } from '../test/real/fixtures.mjs';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const a = { config: null, budgetFile: null, initBudget: false, status: false, execute: false, smokeOnly: false, corpusOnly: false, taskIds: null, acknowledge: null };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--config': a.config = argv[++i]; break;
      case '--budget-file': a.budgetFile = argv[++i]; break;
      case '--init-budget': a.initBudget = true; break;
      case '--status': a.status = true; break;
      case '--execute': a.execute = true; break;
      case '--smoke-only': a.smokeOnly = true; break;
      case '--corpus-only': a.corpusOnly = true; break;
      case '--tasks': case '--resume': {
        const list = argv[++i];
        if (typeof list !== 'string' || list.trim() === '') throw new Error('--tasks requires a comma-separated fixture ID list');
        a.taskIds = list.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '--acknowledge-unknown': {
        // --acknowledge-unknown <attemptNumber> <amountUsd> <reason...>
        const n = Number(argv[++i]);
        const amount = Number(argv[++i]);
        const reason = [];
        while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) reason.push(argv[++i]);
        a.acknowledge = { attemptNumber: n, amountUsd: amount, reason: reason.join(' ').trim() };
        break;
      }
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return a;
}

const defaultBudget = () => resolvePath(process.cwd(), 'state', 'real-budget.json');

/** Reusable driver; integration lane can import this to share the ledger. */
export async function runValidation({
  configPath,
  budgetFile = defaultBudget(),
  execute = false,
  smokeOnly = false,
  corpusOnly = false,
  taskIds = null,
  fetchImpl = globalThis.fetch,
  env = process.env,
  log = (m) => process.stdout.write(m + '\n'),
} = {}) {
  if (!configPath) throw new Error('configPath is required');
  const cfg = loadConfigFile(configPath);
  if (!cfg.enabled) throw new Error('config has enabled:false; real validation requires enabled:true');

  let selectedCorpus = CORPUS;
  if (taskIds !== null) {
    if (!Array.isArray(taskIds) || !taskIds.length || new Set(taskIds).size !== taskIds.length) throw new Error('taskIds must be unique non-empty corpus IDs');
    selectedCorpus = taskIds.map(id => {
      const fixture = CORPUS.find(f => f.id === id);
      if (!fixture) throw new Error('unknown corpus fixture ID');
      return fixture;
    });
    corpusOnly = true;
    smokeOnly = false;
  }
  const status = await budgetStatus({ file: budgetFile });
  log(`[budget] ${JSON.stringify(status)}`);
  if (!execute) {
    log('[preflight] no --execute: no network calls will be made');
    return { mode: 'preflight', status };
  }
  if (!status.initialized) throw new BudgetError('budget ledger not initialized (use --init-budget)', 'NOT_INIT');

  // Mutable context is safe because this runner executes only sequentially.
  // __taskId/__expected are attached BEFORE budgetedFetch so the ledger
  // records which fixture consumed which attempt.
  const ctx = { taskId: null, expected: null };
  const fetch = budgetedFetch(fetchImpl, { file: budgetFile });
  const withContext = (url, init) => fetch(url, {
    ...init,
    __taskId: ctx.taskId,
    __expected: ctx.expected,
  });
  const router = createRouter(cfg, { fetchImpl: withContext, env });

  function classifyModel(model) {
    if (model === cfg.models.light) return 'light';
    if (model === cfg.models.heavy) return 'heavy';
    return 'other';
  }

  async function runOne(id, expected, event) {
    ctx.taskId = id;
    ctx.expected = expected;
    const before = event.input.model ?? null;
    const original = structuredClone(event.input);
    const start = Date.now();
    const result = await router.handleEvent(event);
    const durationMs = Date.now() - start;
    if (!result.routed) throw new Error(`task ${id}: router fallback (${result.reason}); aborting real sequence`);
    const mutated = { ...event.input };
    delete mutated.model;
    const originalWithoutModel = { ...original };
    delete originalWithoutModel.model;
    if (JSON.stringify(mutated) !== JSON.stringify(originalWithoutModel)) {
      throw new Error(`task ${id}: non-model input mutation; aborting`);
    }
    return {
      id,
      expected,
      actual: classifyModel(event.input.model),
      model: event.input.model,
      modelBefore: before,
      durationMs,
    };
  }

  const smokeResults = [];
  if (!corpusOnly) {
    log('[smoke] production handleEvent path; no real child workers');
    for (const sample of SMOKE) {
      const event = structuredClone(sample.event);
      const r = await runOne(sample.id, sample.expected, event);
      if (r.actual !== sample.expected) {
        throw new Error(`smoke ${sample.id} mismatch: expected ${sample.expected}, got ${r.actual}; aborting before corpus`);
      }
      smokeResults.push(r);
      log(`[smoke] ${r.id}: ${r.actual} -> ${r.model} (${r.durationMs}ms)`);
    }
    if (smokeOnly) return { mode: 'smoke', results: smokeResults };
  }

  const corpusResults = [];
  if (!smokeOnly) {
    log(`[corpus] ${selectedCorpus.length} fixed synthetic tasks`);
    for (const f of selectedCorpus) {
      const event = {
        tool: 'subagent',
        id: `evt-${f.id}`,
        sessionID: `ses-${f.id}`,
        input: { agent: f.expected === 'light' ? 'explorer' : 'oracle', prompt: f.task },
      };
      const r = await runOne(f.id, f.expected, event);
      corpusResults.push(r);
      log(`[corpus] ${f.id}: expected=${r.expected} actual=${r.actual} model=${r.model}`);
    }
  }

  const lists = { light: { light: [], heavy: [], other: [] }, heavy: { light: [], heavy: [], other: [] } };
  for (const r of corpusResults) lists[r.expected][r.actual].push(r.id);
  const confusionMatrix = {
    expectedLight_classifiedLight: lists.light.light,
    expectedLight_classifiedHeavy: lists.light.heavy,
    expectedLight_other: lists.light.other,
    expectedHeavy_classifiedLight: lists.heavy.light,
    expectedHeavy_classifiedHeavy: lists.heavy.heavy,
    expectedHeavy_other: lists.heavy.other,
  };
  return {
    mode: smokeOnly ? 'smoke' : 'corpus',
    smoke: smokeResults,
    corpus: corpusResults,
    confusionMatrix: smokeOnly ? null : confusionMatrix,
    note: smokeOnly ? null : '20 samples; descriptive only, no calibration claim',
  };
}

async function main() {
  let args;
  try { args = parseArgs(process.argv); } catch (e) {
    console.error(`error: ${e.message}`);
    console.error('usage: node scripts/real-validation.mjs --init-budget | --config /abs/config.json [--status] [--execute] [--smoke-only|--corpus-only]');
    process.exitCode = 2;
    return;
  }
  const file = args.budgetFile ?? defaultBudget();
  try {
    if (args.acknowledge) {
      await acknowledgeUnknownReserve({ file, ...args.acknowledge });
      console.log(JSON.stringify(await budgetStatus({ file })));
      return; // acknowledgment never sends requests
    }
    if (args.initBudget) {
      const path = await initBudget({ file });
      console.log(`[budget] initialized ${path} (mode 0600); limits: ${BUDGET.maxAttempts} attempts, $${BUDGET.costStopUsd} stop`);
      if (!args.config) return;
    }
    if (args.status) {
      console.log(JSON.stringify(await budgetStatus({ file }), null, 2));
      if (!args.config) return;
    }
    if (!args.config) throw new Error('--config is required unless using only --init-budget or --status');
    const out = await runValidation({
      configPath: args.config,
      budgetFile: file,
      execute: args.execute,
      smokeOnly: args.smokeOnly,
      corpusOnly: args.corpusOnly,
      taskIds: args.taskIds,
    });
    if (out.mode === 'preflight') console.log('[preflight] valid config; no network calls made');
    if (out.confusionMatrix) {
      console.log('\n=== confusion matrix (task IDs) ===');
      for (const [k, v] of Object.entries(out.confusionMatrix)) console.log(`${k}: [${v.join(', ')}] n=${v.length}`);
      console.log(out.note);
    }
  } catch (e) {
    const safe = e instanceof ConfigError || e instanceof BudgetError ? e.message : e.message;
    console.error(`${e instanceof BudgetError ? 'budget blocked' : 'aborted'}: ${safe}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
