# Validation

Validated locally on 2026-10-15 with OpenCode v2.0.28 and installed oh-my-opencode-slim 3.0.2. No production harness installation or configuration changes; repository remains local-only.

## Automated checks

`node --test --test-reporter=tap test/unit/*.test.js test/real/*.test.mjs test/integration/*.test.mjs`

Final result: **85 tests passed, zero failures**. Covers policy/configuration, streamed response bounds and cancellation, lifecycle disposal, credential-safe failures, budget reservations, fixture transport and attribution.

## Native runtime and OMO

`node scripts/integration.mjs`

- 14 native scenario groups passed: direct repository loading, routing both directions, control/pins, classifier failures, concurrency, background completion, same-session resume.
- 26 OMO groups passed across both plugin orders. Actual installed OMO server entry loaded through an isolated directory adapter; activation, disposal and child session model history checked.
- Final mock run: 28 positive OMO activations/disposals, zero external MCP transport references.
- Models verified through actual loopback worker HTTP requests, not assistant self-reports.
- Evidence: `/tmp/opencode/new-decision-router-tests-faX9yC/results.json`.

### Compatibility requirements

OMO-managed agents must use `inheritModelFrom: "session"` and have no scalar model pins in effective presets/overrides. Fixed OMO profiles otherwise override a routed model after session creation.

For OMO resume, acknowledge the completed task with `task_result`, then pass the existing session ID **and its existing qualified model**. Model-less OMO resume was observed to switch the child to the parent's model. This is a documented limitation, not a passing model-preservation case. Native resume without OMO preserved the model.

## Real classifier validation

Endpoint: `https://openrouter.ai/api/alpha/decisions`; model: `microsoft/microsoft-decision-1`. Only synthetic task descriptions sent. Worker inference remained local mock.

- Two initial router smoke events passed.
- Completed labeled corpus: 10 light tasks and 4 heavy tasks, all matched their expected labels. Remaining 6 heavy tasks were not completed; two 20-second request failures led to budget stops. This small partial corpus is not a calibration or general accuracy guarantee.
- User subsequently prioritized six end-to-end cases and approved a 45-second test deadline: native light/heavy and OMO-first/OMO-last light/heavy. **All 6 passed**, with real classifier responses followed by the matching actual child HTTP model and checked session history.
- Real E2E evidence: `/tmp/opencode/new-decision-router-tests-EfR4kd/results.json` and local ignored `artifacts/real-e2e-report.json` / `.md`.

## Budget reconciliation

- 24 of 30 authorized attempts consumed; 6 unused.
- Known reported API cost: **$0.000065058**.
- Two unknown-cost failed attempts remain unknown. User explicitly authorized a **$0.001 reservation for each**; reservations are not claimed as actual charges.
- Accounted known cost plus reservations: **$0.002065058**, below the $0.01 local stop threshold.
- No automatic retries; ledger history retained in ignored `state/real-budget.json`. No unresolved unacknowledged unknown-cost attempts at completion.
- Ordinary inference keys do not provide a per-request hard spending cap; user accepted local accounting and explicit unknown-cost reservations.

## Reproduction and limits

The runtime driver requires the installed OpenCode binary and local OMO package used here. It creates isolated HOME/XDG directories, separate processes and mock endpoints. See driver options and README before running; paid execution is separately opt-in and requires a shared budget ledger.

Evidence paths are local temporary/ignored artifacts, not portable committed fixtures. No credentials are committed. The README documents configurable endpoint/key sources and privacy constraints. Real production worker models, other OpenCode/OMO releases, and full oh-my-opencode were not tested. No claim of universal OMO compatibility or deployment readiness without the documented configuration is made.
