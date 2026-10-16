import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRouterLine, latestEntryForSession, formatIndicator } from '../../tui/src/format.js';
import { readRouterState } from '../../tui/src/read-state.js';

const legacy = {
  sessionID: 'ses_effort', agent: 'explorer', routed: true,
  reason: 'classified', choice: 'heavy', model: 'omniroute/heavy',
};

for (const [profile, choice, effort] of [
  ['light_medium', 'light', 'medium'],
  ['light_high', 'light', 'high'],
  ['heavy_high', 'heavy', 'high'],
  ['heavy_xhigh', 'heavy', 'xhigh'],
]) {
  test(`effort footer: ${profile} through log reader and parser`, async () => {
    const entry = { ...legacy, profile, choice, effort, model: `omniroute/${choice}#${effort}` };
    const result = await readRouterState('config', legacy.sessionID,
      async (path) => path === 'config'
        ? '{"logFile":"log"}' : JSON.stringify(entry));
    assert.equal(result.entry.profile, profile);
    assert.equal(result.entry.effort, effort);
    assert.deepEqual(formatIndicator(result.entry, result), {
      text: `DR · explorer → ${choice}/${effort}`, tone: 'ok',
    });
  });
}

test('legacy and missing effort never infer effort from profile or model', () => {
  for (const entry of [legacy, { ...legacy, profile: 'heavy_xhigh', model: 'omniroute/heavy#xhigh' }]) {
    const parsed = parseRouterLine(JSON.stringify(entry));
    assert.equal(parsed.effort, undefined);
    assert.deepEqual(formatIndicator(parsed), { text: 'DR · explorer → heavy', tone: 'ok' });
  }
});

const malformed = [null, false, 123, {}, [], '', 'two words', ' high', 'high\n',
  '\u001b[31mhigh', 'high\u202ex', 'x'.repeat(10000), 'high/extra'];
for (const field of ['profile', 'effort']) {
  test(`malformed optional ${field} is discarded without dropping latest routing entry`, () => {
    for (const value of malformed) {
      const entry = { ...legacy, profile: 'heavy_high', effort: 'high', [field]: value };
      const parsed = latestEntryForSession([
        JSON.stringify({ ...legacy, choice: 'light' }), JSON.stringify(entry),
      ].join('\n'), legacy.sessionID);
      assert.ok(parsed);
      assert.equal(parsed.choice, 'heavy');
      assert.equal(parsed[field], undefined);
      assert.equal(formatIndicator(parsed).text,
        field === 'effort' ? 'DR · explorer → heavy' : 'DR · explorer → heavy/high');
      if (field === 'effort') assert.equal(formatIndicator(entry).text, 'DR · explorer → heavy');
    }
  });
}

test('optional token length limits and safe custom effort labels', () => {
  const parsed = parseRouterLine(JSON.stringify({ ...legacy, profile: 'p'.repeat(64), effort: 'e'.repeat(32) }));
  assert.equal(parsed.profile.length, 64);
  assert.equal(parsed.effort.length, 32);
  const tooLong = parseRouterLine(JSON.stringify({ ...legacy, profile: 'p'.repeat(65), effort: 'e'.repeat(33) }));
  assert.equal(tooLong.profile, undefined);
  assert.equal(tooLong.effort, undefined);
  for (const effort of ['low', 'max', 'ultra', 'custom-high_2']) {
    assert.equal(formatIndicator(parseRouterLine(JSON.stringify({ ...legacy, effort }))).text,
      `DR · explorer → heavy/${effort}`);
  }
});

test('fallback ignores profile and effort metadata', () => {
  const entry = { ...legacy, routed: false, reason: 'timeout', profile: 'heavy_xhigh', effort: 'xhigh' };
  assert.deepEqual(formatIndicator(entry), formatIndicator({ ...entry, profile: undefined, effort: undefined }));
});
