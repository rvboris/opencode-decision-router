// Fixed synthetic task fixtures for real validation (bounded lane).
// 20 short ASCII tasks: 10 routine (expected light), 10 complex
// (expected heavy: architecture / debugging / security). Plus 2 smoke events.
// ASCII only, short by design; these strings are what gets sent to the
// decisions API (after the router's own maxTaskChars bound).

export const LIGHT_FIXTURES = [
  { id: 'L01', task: 'Find where the config parser reads the timeout option and report the file and line.' },
  { id: 'L02', task: 'Rename the local variable itemCount to totalItems in the cart summary function.' },
  { id: 'L03', task: 'Look up which module exports the formatDate helper and list its call sites.' },
  { id: 'L04', task: 'Add a one-line comment above the retry loop explaining what backoffMs means.' },
  { id: 'L05', task: 'Bump the README install snippet from node 18 to node 20.' },
  { id: 'L06', task: 'Replace the deprecated warning string WARN_OLD with WARN_DEPRECATED in the logger.' },
  { id: 'L07', task: 'Check whether tests use the assert/strict import and report which files do not.' },
  { id: 'L08', task: 'Change the default port constant from 3000 to 8080 in the dev server config.' },
  { id: 'L09', task: 'Fix the typo in the error message: recieve should be receive.' },
  { id: 'L10', task: 'List the exported functions of the policy module and summarize each in one line.' },
];

export const HEAVY_FIXTURES = [
  { id: 'H01', task: 'Diagnose why concurrent ledger writes occasionally lose the last attempt under load, and propose a locking design.' },
  { id: 'H02', task: 'Review this auth middleware design for security weaknesses: bearer tokens are validated with a substring match.' },
  { id: 'H03', task: 'Our plugin registry has circular initialization between config and hooks; redesign the startup ordering.' },
  { id: 'H04', task: 'A race between session resume and model routing duplicates classifier calls; trace the lifecycle and fix the invariants.' },
  { id: 'H05', task: 'Design a backward-compatible schema migration for the budget ledger when attempt records gain new fields.' },
  { id: 'H06', task: 'Intermittent timeout only on heavy tasks: analyze whether timeout should cover body reads and how aborts propagate.' },
  { id: 'H07', task: 'Evaluate an architecture where routing decisions are cached per agent versus per session; identify failure modes.' },
  { id: 'H08', task: 'A redirect-following client forwarded credentials once; audit the fetch layer and design defense in depth.' },
  { id: 'H09', task: 'Refactor a 900-line god function that mixes parsing, IO and policy; propose module boundaries and migration steps.' },
  { id: 'H10', task: 'Debug a flaky integration test where two parallel handleEvent calls observe each other partial state; reason about the mutex.' },
];

export const CORPUS = [
  ...LIGHT_FIXTURES.map((f) => ({ ...f, expected: 'light' })),
  ...HEAVY_FIXTURES.map((f) => ({ ...f, expected: 'heavy' })),
];

// Two smoke events exercising the real production handleEvent path.
// The resulting input.model is compared against the mapped target for the
// expected choice (mock model mapping; no real child OpenCode launch).
export const SMOKE = [
  {
    id: 'S01',
    expected: 'light',
    task: 'Rename the helper isEmtpy to isEmpty across the utils module.',
    event: {
      tool: 'subagent',
      id: 'evt-smoke-1',
      sessionID: 'ses-smoke-1',
      input: { agent: 'explorer', prompt: 'Rename the helper isEmtpy to isEmpty across the utils module.' },
    },
  },
  {
    id: 'S02',
    expected: 'heavy',
    task: 'Diagnose an auth bypass where refresh tokens are accepted without expiry checks, and design the fix.',
    event: {
      tool: 'subagent',
      id: 'evt-smoke-2',
      sessionID: 'ses-smoke-2',
      input: { agent: 'oracle', prompt: 'Diagnose an auth bypass where refresh tokens are accepted without expiry checks, and design the fix.' },
    },
  },
];
