# opencode-decision-router

OpenCode **V2 plugin** that classifies delegated subagent tasks through a
"decisions" API (default: OpenRouter Microsoft Decision) and routes the child
model to `omniroute/light` or `omniroute/heavy`. Zero dependencies, JS ESM,
Node >= 18.

**V2 only.** Local mock integration verifies native delegation on OpenCode
2.0.28, including foreground, background and same-session resume. The installed
**oh-my-opencode-slim 3.0.2** server entry passes the mock matrix in both plugin
orders through an isolated directory adapter, subject to the configuration and
resume requirements below. Six additional end-to-end cases passed with the real
Microsoft Decision API and mock worker inference (native and both OMO plugin
orders, light/heavy). No real worker-model inference was used. See
[VALIDATION.md](VALIDATION.md) for evidence and limitations.

### OMO configuration requirements

Router-managed OMO agents (for example fixer and explorer) must use
`inheritModelFrom: "session"` with **no scalar `model`** in their effective config.
Remove scalar model pins from active presets and override layers as well as native
agent configuration. Unrelated agents and the orchestrator may retain fixed models.
Otherwise OMO switches the routed child back to its configured profile model before
inference. Classification failure with session inheritance falls back to the parent
model, rather than a fixed specialist profile.

For an OMO-managed completed child, retrieve/acknowledge it with `task_result`
before native resume. Pass its existing qualified model along with `sessionID`:
OMO 3.0.2 otherwise switches an inherited child to the parent's model on resume.
The router skips classification for resume. The mock gate explicitly verifies the
same session and unchanged model, with no child `model-switched` history entries.
Native resume without OMO does not need that explicit model.

Run `node scripts/integration.mjs` for the isolated loopback-only matrix, or
`node --test test/integration/*.test.mjs` for transport fixtures. All built-in MCPs,
including `gh_grep`, are disabled in the scratch OMO config.

## Opt-in installation

Routing is **disabled by default**. Load the V2 plugin directly from the
absolute repository directory in the OpenCode `plugins` array (do not add a
wrapper module):

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-decision-router"]
}
```

The root `index.js` re-exports `src/index.js` and is required by the tested V2
directory loader; package exports alone did not activate the plugin. Setup returns
idempotent cleanup that aborts pending classifications and disposes the hook
registration. The plugin reads its JSON configuration from an absolute path in the
environment:

```sh
export OPENCODE_DECISION_ROUTER_CONFIG=/absolute/path/to/config.json
```

If that variable is unset or empty, `setup()` installs no hooks and the plugin
has no effect. If the config file is missing, invalid JSON, or fails
validation, routing is also disabled (fail-safe) and a metadata message is
written to stderr (file contents are never echoed).

See `examples/config.json` for a full annotated example.

## Configuration

| Field | Default | Notes |
|---|---|---|
| `enabled` | `false` | Master switch; must be `true` to install the hook. |
| `endpoint` | `https://openrouter.ai/api/alpha/decisions` | **Configurable.** HTTPS required; plain HTTP only for loopback (`localhost`/`127.0.0.1`) test endpoints. Credentials in the URL are rejected. |
| `apiKeyEnv` | `OPENROUTER_API_KEY` | **Configurable.** Name of the environment variable holding the bearer key. |
| `apiKeyFile` | `null` | **Configurable.** Optional absolute path to a raw key file. Content must be exactly one unambiguous token (trimmed; internal whitespace, quotes and comment markers are rejected). Takes effect only when the env var is unset. |
| `decisionModel` | `microsoft/microsoft-decision-1` | Model used for the classification request. |
| `models.light` / `models.heavy` | `omniroute/light` / `omniroute/heavy` | The only two targets the classifier may choose. |
| `agents` | explorer, librarian, fixer, oracle, designer, observer | Allowlist of subagent names that may be re-routed. |
| `timeoutMs` | `5000` | Integer from 1 to 60000; covers the entire request, including the response body. |
| `maxTaskChars` | `4000` | Integer from 1 to 16000; the delegated prompt (or description fallback) is truncated to this before sending. |
| `logFile` | `null` | Optional absolute path. Structured JSON-lines metadata only. |

## Routing policy

The `execute.before` hook fires only for the native `subagent` tool and only
for allowlisted agents. An event is skipped (untouched) when:

- the tool is not `subagent`;
- the agent is not in `agents`;
- `input.sessionID` is set (resume of an existing child session keeps its model);
- an explicit model is set that is **not** one of the configured light/heavy
  pair — including any `#variant` of an unrelated model. Variants of the
  configured pair *are* re-classified, which is how an existing pinned
  heavy/light rule can be replaced.

Otherwise the bounded task text is classified. On a strictly valid answer
(`answers.routing.type === 'choice'` with `choice` exactly `light` or `heavy`)
only `event.input.model` is rewritten; every other argument is preserved. Any
failure — no key, network error, timeout, HTTP error, redirect, malformed
answer — preserves the event entirely (fail-open). No retries.

## Exports (from `src/index.js`)

- `default` — `{ id: 'decision-router', async setup(ctx) }` (the V2 plugin)
- `createRouter(config, dependencies?)` — testable core:
  `{ handleEvent(event), evaluateEvent(event), config }`;
  `dependencies: { fetchImpl, now, log }`
- `loadConfigFromEnv(env?)`, `loadConfigFile(path)`, `validateConfig(raw)` — config helpers
- `resolveApiKey(cfg, env?, readFile?)`, `parseApiKeyFileContent(raw)`
- `evaluateEvent(event, cfg)`, `parseModelId(model)`, `validateDecisionResponse(body, cfg)`
- `classifyTask(cfg, task, apiKey, { fetchImpl })`, `buildDecisionRequest(cfg, task)`
- `ConfigError`, `DecisionsRequestError`, `DEFAULTS`

## Privacy

- Only the **bounded delegated task text** is sent — not the session history,
  not files. **Truncation is partial filtering, not a secret guarantee**: task
  text may itself contain sensitive content, and it is transmitted to the
  configured endpoint. This trade-off is explicit and opt-in.
- Credentials (env var or key file) are never written to logs or error
  messages, and redirects are refused so the key is never forwarded elsewhere.
- Logs (`logFile`) contain structured metadata only: event/session IDs,
  agent, chosen model, fallback reason, latency. Never prompt, key, or
  response body.

## TUI routing indicator

The package also ships a TUI plugin (`export "./tui"`) that renders the latest
routing decision for the current session in the OpenCode status footer
(`prompt.footer.status` slot):

- `DR light→omniroute/light (0.8s)` — latest logged classification (the current server log does not include confidence);
- `DR fallback: keep omniroute/heavy (timeout)` — original model kept;
- `DR off` (muted) — `OPENCODE_DECISION_ROUTER_CONFIG` is not set, or the referenced config has `enabled: false`;
- `DR: ожидание решения` (muted) — no logged decision for this session yet;
- `DR: ожидание решения · нет лога` (muted) — the log does not exist yet; this is not treated as a server failure;
- `DR: конфиг недоступен`, `DR: ошибка конфига`, `DR: logFile не задан`, or `DR: лог недоступен` (warning) — local read/config diagnostics, without paths or error bodies.

The indicator remains visible before the first decision. Local environment/config
presence is **not** proof that the server router is active. Session changes clear
the previous decision immediately; an older asynchronous read cannot restore it.

It reads the `logFile` from the env-referenced config, refreshes on session
lifecycle events plus a 2 s poll, and cleans up (slot, listeners, interval) on
dispose. Registration is already covered by the existing plugin entry — the
host loads both `.` and `./tui` exports; only the build step is needed:

```
npm run build -w tui
```

Indicator formatting and injected read/session-state logic live in
`tui/src/format.js` and `tui/src/read-state.js`, covered by
`test/unit/tui-format.test.js` and `test/unit/tui-read-state.test.js`.

## Tests

```sh
npm test        # node --test test/unit/*.test.js
```

Unit tests only (config, policy, client, router), using injected fakes and
loopback HTTP servers. **No real API calls are made and no integration or
OMO-compatibility claims are made by this suite.**
