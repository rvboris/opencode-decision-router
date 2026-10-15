import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateConfig,
  loadConfigFile,
  loadConfigFromEnv,
  resolveApiKey,
  parseApiKeyFileContent,
  ConfigError,
  DEFAULTS,
} from '../../src/config.js';

test('defaults match the approved contract', () => {
  const cfg = validateConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.endpoint, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(cfg.apiKeyEnv, 'OPENROUTER_API_KEY');
  assert.equal(cfg.apiKeyFile, null);
  assert.equal(cfg.decisionModel, 'microsoft/microsoft-decision-1');
  assert.deepEqual(cfg.models, { light: 'omniroute/light', heavy: 'omniroute/heavy' });
  assert.deepEqual(cfg.agents, ['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'observer']);
  assert.equal(cfg.timeoutMs, 5000);
  assert.equal(cfg.maxTaskChars, 4000);
  assert.equal(cfg.logFile, null);
  assert.deepEqual(Object.keys(DEFAULTS.models), ['light', 'heavy']);
});

test('validateConfig accepts valid overrides', () => {
  const cfg = validateConfig({
    enabled: true,
    endpoint: 'https://example.invalid/api',
    apiKeyEnv: 'MY_KEY',
    decisionModel: 'foo/bar',
    models: { light: 'a/light', heavy: 'b/heavy' },
    agents: ['explorer'],
    timeoutMs: 100,
    maxTaskChars: 50,
  });
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.models, { light: 'a/light', heavy: 'b/heavy' });
  assert.deepEqual(cfg.agents, ['explorer']);
});

test('validateConfig rejects invalid values', () => {
  assert.throws(() => validateConfig([]), ConfigError);
  assert.throws(() => validateConfig({ enabled: 'yes' }), ConfigError);
  assert.throws(() => validateConfig({ endpoint: 'not a url' }), ConfigError);
  assert.throws(() => validateConfig({ endpoint: 'http://example.com/api' }), ConfigError); // non-loopback http
  assert.throws(() => validateConfig({ endpoint: 'https://u:p@example.com' }), ConfigError); // embedded creds
  assert.throws(() => validateConfig({ models: { light: 'x', heavy: 'y', extra: 'z' } }), ConfigError);
  assert.throws(() => validateConfig({ agents: [] }), ConfigError);
  assert.throws(() => validateConfig({ timeoutMs: -1 }), ConfigError);
  assert.throws(() => validateConfig({ maxTaskChars: 0 }), ConfigError);
  assert.throws(() => validateConfig({ timeoutMs: 1.5 }), ConfigError);
  assert.throws(() => validateConfig({ timeoutMs: 60001 }), ConfigError);
  assert.throws(() => validateConfig({ maxTaskChars: 1.5 }), ConfigError);
  assert.throws(() => validateConfig({ maxTaskChars: 16001 }), ConfigError);
  assert.throws(() => validateConfig({ models: { light: 'bad id', heavy: 'b/heavy' } }), ConfigError);
  assert.throws(() => validateConfig({ models: { light: 'a/', heavy: 'b/heavy' } }), ConfigError);
  assert.throws(() => validateConfig({ models: { light: 'a/light#', heavy: 'b/heavy' } }), ConfigError);
  assert.throws(() => validateConfig({ apiKeyFile: 'relative/key.txt' }), ConfigError);
  assert.throws(() => validateConfig({ logFile: 'relative/path.log' }), ConfigError);
});

test('loopback plain HTTP endpoint is allowed (for tests)', () => {
  const cfg = validateConfig({ endpoint: 'http://127.0.0.1:9/api' });
  assert.equal(cfg.endpoint, 'http://127.0.0.1:9/api');
  validateConfig({ endpoint: 'http://localhost:9/api' });
});

test('the shipped examples/config.json is valid and loadable JSON', () => {
  const path = fileURLToPath(new URL('../../examples/config.json', import.meta.url));
  const cfg = loadConfigFile(path);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.models.light, 'omniroute/light');
});

test('loadConfigFile parses JSON and rejects bad files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dr-cfg-'));
  const ok = join(dir, 'ok.json');
  writeFileSync(ok, JSON.stringify({ enabled: true, timeoutMs: 123 }));
  const cfg = loadConfigFile(ok);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.timeoutMs, 123);

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{nope');
  assert.throws(() => loadConfigFile(bad), ConfigError);
  assert.throws(() => loadConfigFile(join(dir, 'missing.json')), ConfigError);
  assert.throws(() => loadConfigFile('relative.json'), ConfigError);
});

test('loadConfigFromEnv: unset env means routing disabled with defaults', () => {
  const cfg = loadConfigFromEnv({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.endpoint, DEFAULTS.endpoint);
  const cfg2 = loadConfigFromEnv({ OPENCODE_DECISION_ROUTER_CONFIG: '   ' });
  assert.equal(cfg2.enabled, false);
  assert.throws(() => loadConfigFromEnv({ OPENCODE_DECISION_ROUTER_CONFIG: 'relative.json' }), /absolute path/);
});

test('loadConfigFromEnv: set env loads and validates the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dr-env-'));
  const p = join(dir, 'cfg.json');
  writeFileSync(p, JSON.stringify({ enabled: true }));
  const cfg = loadConfigFromEnv({ OPENCODE_DECISION_ROUTER_CONFIG: p });
  assert.equal(cfg.enabled, true);
  assert.throws(() => loadConfigFromEnv({ OPENCODE_DECISION_ROUTER_CONFIG: join(dir, 'nope.json') }), ConfigError);
});

test('resolveApiKey prefers env, then file; missing key -> null', () => {
  const cfg = { apiKeyEnv: 'K', apiKeyFile: null };
  assert.deepEqual(resolveApiKey(cfg, { K: '  sk-test  ' }), { key: 'sk-test', source: 'env:K' });
  assert.equal(resolveApiKey(cfg, {}), null);

  const dir = mkdtempSync(join(tmpdir(), 'dr-key-'));
  const f = join(dir, 'key.txt');
  writeFileSync(f, '  filetoken \n');
  const withFile = { apiKeyEnv: 'K', apiKeyFile: f };
  assert.deepEqual(resolveApiKey(withFile, {}), { key: 'filetoken', source: 'file' });
  // env wins over file
  assert.deepEqual(resolveApiKey(withFile, { K: 'envtoken' }), { key: 'envtoken', source: 'env:K' });

  assert.throws(() => resolveApiKey({ apiKeyEnv: 'K', apiKeyFile: join(dir, 'nope') }, {}), ConfigError);
  assert.throws(() => resolveApiKey({ apiKeyEnv: 'K', apiKeyFile: 'relative' }, {}), ConfigError);
});

test('parseApiKeyFileContent rejects ambiguous formatting without echoing content', () => {
  assert.throws(() => parseApiKeyFileContent(''), ConfigError);
  assert.throws(() => parseApiKeyFileContent('   \n  \n'), ConfigError);
  assert.throws(() => parseApiKeyFileContent('two tokens here'), ConfigError);
  assert.throws(() => parseApiKeyFileContent('line1\nline2'), ConfigError);
  assert.throws(() => parseApiKeyFileContent('"quoted"'), ConfigError);
  assert.throws(() => parseApiKeyFileContent("'quoted'"), ConfigError);
  assert.throws(() => parseApiKeyFileContent('# comment-like'), ConfigError);
  assert.equal(parseApiKeyFileContent('  sk-or-v1-abc123 \n'), 'sk-or-v1-abc123');
});
