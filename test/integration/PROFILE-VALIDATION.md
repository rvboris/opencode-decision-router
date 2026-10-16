# Model + effort validation (2026-10-16)

## Scope and contract

Mock-only execution against the installed local OpenCode runtime, isolated HOME/XDG directories and dummy API credentials. No paid API calls, production configuration changes, restarts, or commits. This does not establish real upstream support for effort levels.

Optional profiles map `label_effort` IDs to `{ model, label, effort, description }`. Labels are light/heavy, supported efforts medium/high/xhigh, target variants must match effort. Provider/model names are independently configurable. The four initial examples are not a hardcoded restriction on label/effort combinations. Responses must select an exact configured ID. Logs/results retain light/heavy `choice`, add `profile` and `effort`, and preserve full `model#variant`. Legacy mode has no additional profile fields.

## Executed commands

- `node --test test/unit/*.test.js test/real/*.test.mjs test/integration/*.test.mjs`: **150 passed, 0 failed/skipped**, `/tmp/opencode/effort-tests-final.log`.
- `node scripts/integration.mjs --profiles --cases profiles-matrix`: **51 groups passed, 0 failed (54 runtime scenarios)**. Final evidence: `/tmp/opencode/new-decision-router-tests-6oYMBP/results.json`.
- `node scripts/integration.mjs`: final rerun **14 native + 26 OMO groups passed, 0 failures**. Evidence: `/tmp/opencode/new-decision-router-tests-HU4qBC/results.json`, log `/tmp/opencode/effort-legacy-final.log`. Initial complete run also passed: `/tmp/opencode/new-decision-router-tests-ZZvzwT/results.json`.
- `git diff --check`: passed.

## Actual effort evidence

Each profile's smoke/background/resume cases passed in native, OMO-first, and OMO-last order (36 cases). The harness checks child assistant history from the runtime SQLite database, not merely the requested string. `child-models.json` records `model.providerID`, `model.id`, and `model.variant`. The worker HTTP server captures the serialized request field **`reasoning_effort`**, which is the actual field emitted by the configured OpenAI-compatible SDK:

| Profile | Child model | Child variant | HTTP reasoning_effort |
| --- | --- | --- | --- |
| light_medium | light | medium | medium |
| light_high | light | high | high |
| heavy_high | heavy | high | high |
| heavy_xhigh | heavy | xhigh | xhigh |

This held for all three plugin arrangements, including background and both requests of resumed sessions. Router logs separately assert exact `mock/model#variant`. Resume checks also assert session continuity, one classifier call, and no child model-switch history.

Additional profile matrix groups: 3 unrelated-model pins, 9 fallback cases (HTTP unauthorized, invalid choice, timeout), and 3 concurrent mixed-profile pairs. Legacy matrix separately exercises rate limiting, server errors, invalid JSON, disabled routing, and other original cases.

Evidence under each scenario directory: `worker.json`, `child-models.json`, `router.jsonl`, `decisions.json`, `model-switches.json`, isolated configuration, stdout/stderr, and runtime database. Aggregate file is `results.json` (not summary.json).

## Repairs during validation

Removed unintended model-name-equals-display-label validation and allowed additional valid label/effort combinations; added custom provider/model test. Removed internal fixture `resumeModel` from native subagent arguments. Added direct runtime child-variant assertions and a fixture regression test.

Intermediate duplicate reruns exhausted the filesystem quota (errno -122), not a routing assertion failure. Removed only generated cache directories in specifically inspected isolated harness roots, preserving databases and evidence. Profile rerun then passed completely; the legacy rerun was repeated after a second cache cleanup. No production files were removed.
