import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRouterLine, latestEntryForSession, tailText, formatIndicator } from '../../tui/src/format.js';

const routedEntry = {
  eventId: 'evt_1',
  sessionID: 'ses_a',
  agent: 'build',
  taskChars: 120,
  routed: true,
  reason: 'classified',
  choice: 'light',
  model: 'omniroute/light',
  latencyMs: 812,
};

test('parseRouterLine: valid routed line', () => {
  const parsed = parseRouterLine(JSON.stringify(routedEntry));
  assert.equal(parsed.choice, 'light');
  assert.equal(parsed.model, 'omniroute/light');
  assert.equal(parsed.routed, true);
});

test('parseRouterLine: fallback line without choice/model is valid', () => {
  const line = JSON.stringify({ eventId: 'e2', sessionID: 'ses_b', agent: 'build', taskChars: 5, routed: false, reason: 'no-api-key', latencyMs: 3 });
  const parsed = parseRouterLine(line);
  assert.equal(parsed.routed, false);
  assert.equal(parsed.reason, 'no-api-key');
});

test('parseRouterLine: routed line missing model is malformed', () => {
  const bad = { ...routedEntry, model: undefined };
  assert.equal(parseRouterLine(JSON.stringify(bad)), null);
});

test('parseRouterLine: malformed JSON returns null', () => {
  assert.equal(parseRouterLine('{not json'), null);
});

test('parseRouterLine: non-object json returns null', () => {
  assert.equal(parseRouterLine('"str"'), null);
  assert.equal(parseRouterLine('[1,2]'), null);
  assert.equal(parseRouterLine('null'), null);
});

test('parseRouterLine: missing sessionID or routed returns null', () => {
  assert.equal(parseRouterLine('{"routed":true,"reason":"x"}'), null);
  assert.equal(parseRouterLine('{"sessionID":"s"}'), null);
});

test('parseRouterLine: empty/non-string input returns null', () => {
  assert.equal(parseRouterLine(''), null);
  assert.equal(parseRouterLine('   '), null);
  assert.equal(parseRouterLine(undefined), null);
});

test('latestEntryForSession: picks last matching entry', () => {
  const text = [
    JSON.stringify({ ...routedEntry, sessionID: 'ses_other' }),
    JSON.stringify({ ...routedEntry, sessionID: 'ses_a', latencyMs: 100 }),
    JSON.stringify({ ...routedEntry, sessionID: 'ses_a', latencyMs: 900 }),
  ].join('\n');
  const entry = latestEntryForSession(text, 'ses_a');
  assert.equal(entry.latencyMs, 900);
});

test('latestEntryForSession: no match returns null', () => {
  const text = JSON.stringify(routedEntry);
  assert.equal(latestEntryForSession(text, 'ses_missing'), null);
  assert.equal(latestEntryForSession('', 'ses_a'), null);
  assert.equal(latestEntryForSession(text, ''), null);
});

test('latestEntryForSession: skips malformed lines', () => {
  const text = ['{"broken', JSON.stringify({ ...routedEntry, latencyMs: 77 })].join('\n');
  assert.equal(latestEntryForSession(text, 'ses_a').latencyMs, 77);
});

test('tailText: keeps only last lines', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);
  const tail = tailText(lines.join('\n'), 3);
  assert.deepEqual(tail.split('\n'), ['l7', 'l8', 'l9']);
});

test('formatIndicator: routed entry shows choice, model, latency', () => {
  const r = formatIndicator(routedEntry, { enabled: true });
  assert.equal(r.text, 'DR light→omniroute/light (0.8s)');
  assert.equal(r.tone, 'ok');
});

test('formatIndicator: confidence included as percent when present', () => {
  const r = formatIndicator({ ...routedEntry, confidence: 0.98 }, { enabled: true });
  assert.equal(r.text, 'DR light→omniroute/light (98%, 0.8s)');
});

test('formatIndicator: fallback entry', () => {
  const r = formatIndicator({ ...routedEntry, routed: false, reason: 'timeout', model: 'omniroute/heavy', latencyMs: 2000 }, { enabled: true });
  assert.equal(r.text, 'DR fallback: keep omniroute/heavy (timeout)');
  assert.equal(r.tone, 'warn');
});

test('formatIndicator: fallback without model uses generic label', () => {
  const entry = { ...routedEntry, routed: false, reason: 'no-api-key' };
  delete entry.model;
  const r = formatIndicator(entry, { enabled: true });
  assert.equal(r.text, 'DR fallback: keep model (no-api-key)');
});

test('formatIndicator: off state is gray text regardless of entries', () => {
  const r = formatIndicator(routedEntry, { enabled: false });
  assert.equal(r.text, 'DR off');
  assert.equal(r.tone, 'off');
});

test('formatIndicator: no entry while enabled hides the indicator', () => {
  const r = formatIndicator(null, { enabled: true });
  assert.equal(r.text, null);
});

test('formatIndicator: missing latency omits seconds', () => {
  const r = formatIndicator({ ...routedEntry, latencyMs: null }, { enabled: true });
  assert.equal(r.text, 'DR light→omniroute/light');
});
