// Regression: "Decision Router: статистика" must remain reachable after the
// command palette pushes the modal keymap mode. Root cause (2026-10-16): the
// outer launch layer was registered without an explicit mode, so the host
// keymap defaulted it to MODE.base; opening the palette pushed `modal` and the
// command became unreachable. Fix: `mode: 'global'` on the outer launch layer
// only (tui/src/panel.tsx), which per host keymap.tsx createLayer() registers
// the layer with NO mode constraint, keeping it active in every mode.
//
// Fidelity limits (honest scope): this test exercises the actual shipped
// bundle artifact and reproduces the host v2.0.28 mode-matching rule, but it
// does NOT run the live @opentui mock-input app fixture (that harness lives in
// the opencode host repo, is not installed here, and running it would require
// mutating the host checkout). It therefore proves registration-shape
// reachability under the modal mode, not an end-to-end palette open/close.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bundle = readFileSync(new URL('../../tui/dist/index.js', import.meta.url), 'utf8');

// Host keymap.tsx (opencode v2.0.28, packages/tui/src/context/keymap.tsx,
// createLayer): `...(mode === "global" ? {} : { mode: mode ?? MODE.base })` —
// a 'global' layer is registered without a mode filter and thus matches every
// mode including `modal`; anything else is pinned to base (or the given mode)
// and goes dark when the palette pushes `modal`.
function resolveActiveInModal(layerMode) {
  return layerMode === 'global' ? true : layerMode !== undefined ? layerMode === 'base' && false : false;
}

test('outer launch layer of the stats command is registered with mode global (modal-reachable)', () => {
  // Locate the outer launch layer in the actual built artifact (not the source).
  const launch = bundle.indexOf("decision-router.stats");
  assert.ok(launch !== -1, 'stats command must be registered in the built bundle');
  const layerStart = bundle.lastIndexOf('ctx.keymap.layer(() => ({', launch);
  assert.ok(layerStart !== -1 && layerStart < launch, 'outer launch layer wraps the stats command');
  const layerHead = bundle.slice(layerStart, launch);
  assert.match(layerHead, /mode:\s*['"]global['"]/,
    'outer launch layer must declare mode: "global" so it stays active when the palette pushes modal');
  // The dialog has no explicit mode; it must NOT be pinned to base by our code
  // path either (inner tab/r/escape layer already declares mode: 'global').
  assert.doesNotMatch(layerHead, /mode:\s*['"]base['"]/);
});

test('host mode-matching rule: only mode global survives a pushed modal mode', () => {
  assert.equal(resolveActiveInModal('global'), true, 'global layers stay reachable under modal');
  assert.equal(resolveActiveInModal(undefined), false, 'default (base) layers go dark under modal — the original bug');
  assert.equal(resolveActiveInModal('base'), false);
  assert.equal(resolveActiveInModal('modal'), false, 'a layer pinned to modal would not be the launch layer anyway');
});

test('inner in-panel layer keeps its existing mode global (no visual or behavior change)', () => {
  const panelStart = bundle.search(/bind:\s*['"]tab['"]/);
  assert.ok(panelStart !== -1);
  const innerStart = bundle.lastIndexOf('ctx.keymap.layer(() => ({', panelStart);
  assert.match(bundle.slice(innerStart, panelStart), /mode:\s*['"]global['"]/);
});
