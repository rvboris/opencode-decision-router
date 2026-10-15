import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEvent, parseModelId, validateDecisionResponse } from '../../src/policy.js';
import { DEFAULTS } from '../../src/config.js';

const cfg = Object.freeze({
  ...DEFAULTS,
  enabled: true,
  models: { light: 'omniroute/light', heavy: 'omniroute/heavy' },
  agents: ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'observer'],
  maxTaskChars: 100,
});

function evt(overrides = {}, inputOverrides = {}) {
  return {
    tool: 'subagent',
    sessionID: 'ses_parent',
    id: 'evt1',
    input: { agent: 'explorer', prompt: 'do a thing', ...inputOverrides },
    ...overrides,
  };
}

test('only the subagent tool is hooked', () => {
  assert.equal(evaluateEvent(evt({ tool: 'bash' }, {}), cfg).action, 'skip');
  assert.equal(evaluateEvent(evt({ tool: 'bash' }, {}), cfg).reason, 'tool-not-subagent');
});

test('agents outside the allowlist are skipped', () => {
  assert.equal(evaluateEvent(evt({}, { agent: 'build' }), cfg).reason, 'agent-not-allowlisted');
  assert.equal(evaluateEvent(evt({}, { agent: undefined }), cfg).reason, 'agent-not-allowlisted');
  for (const a of cfg.agents) {
    assert.equal(evaluateEvent(evt({}, { agent: a }), cfg).action, 'classify');
  }
});

test('resume (input.sessionID present) is skipped', () => {
  const r = evaluateEvent(evt({}, { sessionID: 'ses_child_existing' }), cfg);
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'resume-session');
});

test('explicit model outside the mapped pair is skipped, including variants', () => {
  assert.equal(evaluateEvent(evt({}, { model: 'openai/gpt-5' }), cfg).reason, 'pinned-model');
  assert.equal(evaluateEvent(evt({}, { model: 'openai/gpt-5#high' }), cfg).reason, 'pinned-model');
  assert.equal(evaluateEvent(evt({}, { model: 'omniroute/other' }), cfg).reason, 'pinned-model');
  assert.equal(evaluateEvent(evt({}, { model: 'other/provider/model#fast' }), cfg).reason, 'pinned-model');
});

test('configured mapping variants are compared by base in both directions', () => {
  const variantCfg = { ...cfg, models: { light: 'omniroute/light#fast', heavy: 'omniroute/heavy#max' } };
  assert.equal(evaluateEvent(evt({}, { model: 'omniroute/light#fast' }), variantCfg).action, 'classify');
  assert.equal(evaluateEvent(evt({}, { model: 'omniroute/heavy#max' }), variantCfg).action, 'classify');
  assert.equal(evaluateEvent(evt({}, { model: 'omniroute/heavy' }), variantCfg).action, 'classify');
  assert.equal(evaluateEvent(evt({}, { model: 'omniroute/light' }), variantCfg).action, 'classify');
  assert.equal(evaluateEvent(evt({}, {}), cfg).action, 'classify');
});

test('resume with mapped variants stays untouched', () => {
  const variantCfg = { ...cfg, models: { light: 'omniroute/light#fast', heavy: 'omniroute/heavy#max' } };
  const event = evt({}, { model: 'omniroute/heavy#max', sessionID: 'ses-resume' });
  assert.equal(evaluateEvent(event, variantCfg).reason, 'resume-session');
  assert.equal(event.input.model, 'omniroute/heavy#max');
});

test('task text: prompt preferred, description fallback, bounded to maxTaskChars', () => {
  const long = 'x'.repeat(250);
  let r = evaluateEvent(evt({}, { prompt: long }), cfg);
  assert.equal(r.action, 'classify');
  assert.equal(r.task.length, 100);

  r = evaluateEvent(evt({}, { prompt: '', description: 'desc task' }), cfg);
  assert.equal(r.task, 'desc task');

  r = evaluateEvent(evt({}, { prompt: '', description: '' }), cfg);
  assert.equal(r.reason, 'no-task-text');
});

test('malformed events are skipped safely', () => {
  assert.equal(evaluateEvent(null, cfg).action, 'skip');
  assert.equal(evaluateEvent({}, cfg).action, 'skip');
  assert.equal(evaluateEvent({ tool: 'subagent', input: null }, cfg).action, 'skip');
});

test('parseModelId handles base and variant forms', () => {
  assert.deepEqual(parseModelId('omniroute/light'), { base: 'omniroute/light', variant: null });
  assert.deepEqual(parseModelId('omniroute/light#fast'), { base: 'omniroute/light', variant: 'fast' });
  assert.equal(parseModelId(''), null);
  assert.equal(parseModelId('m#'), null);
  assert.equal(parseModelId(undefined), null);
});

test('validateDecisionResponse is strict', () => {
  const ok = { answers: { routing: { type: 'choice', choice: 'heavy' } } };
  assert.equal(validateDecisionResponse(ok, cfg), 'heavy');
  assert.equal(validateDecisionResponse({ answers: { routing: { type: 'choice', choice: 'light' } } }, cfg), 'light');
  // Rejects everything else
  assert.equal(validateDecisionResponse({ answers: { routing: { type: 'choice', choice: 'turbo' } } }, cfg), null);
  assert.equal(validateDecisionResponse({ answers: { routing: { type: 'text', choice: 'light' } } }, cfg), null);
  assert.equal(validateDecisionResponse({ answers: {} }, cfg), null);
  assert.equal(validateDecisionResponse({}, cfg), null);
  assert.equal(validateDecisionResponse('light', cfg), null);
  assert.equal(validateDecisionResponse(null, cfg), null);
  // Custom mapped models are used for validation of existence only
  const custom = { ...cfg, models: { light: 'a/l', heavy: 'b/h' } };
  assert.equal(validateDecisionResponse(ok, custom), 'heavy');
});
