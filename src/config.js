// Configuration loading and validation for the OpenCode V2 decision router.
// Zero dependencies. JS ESM. Node >= 18.

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const DEFAULTS = Object.freeze({
  enabled: false,
  endpoint: 'https://openrouter.ai/api/alpha/decisions',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  apiKeyFile: null,
  decisionModel: 'microsoft/microsoft-decision-1',
  models: Object.freeze({ light: 'omniroute/light', heavy: 'omniroute/heavy' }),
  agents: Object.freeze(['explorer', 'librarian', 'fixer', 'oracle', 'designer', 'observer']),
  timeoutMs: 5000,
  maxTaskChars: 4000,
  logFile: null,
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validModelId(value) {
  return typeof value === 'string' &&
    /^[^\s/#]+\/(?:[^\s#]+)(?:#[^\s#]+)?$/.test(value);
}

function requireString(obj, key, { allowEmpty = false } = {}) {
  const v = obj[key];
  if (typeof v !== 'string' || (!allowEmpty && v.length === 0)) {
    throw new ConfigError(`config.${key} must be a non-empty string`);
  }
  return v;
}

function isLoopbackHttp(url) {
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1' ||
      url.hostname === '[::1]')
  );
}

// A key file must hold exactly one unambiguous token: after trimming outer
// whitespace there must be no internal whitespace, no quotes and no comment
// markers. Anything else is rejected rather than guessed at.
export function parseApiKeyFileContent(raw) {
  if (typeof raw !== 'string') throw new ConfigError('apiKeyFile content is not text');
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new ConfigError('apiKeyFile is empty');
  if (/[\s]/.test(trimmed)) {
    throw new ConfigError('apiKeyFile has ambiguous formatting (internal whitespace or multiple lines)');
  }
  if (/["']/.test(trimmed)) {
    throw new ConfigError('apiKeyFile has ambiguous formatting (quotes)');
  }
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
    throw new ConfigError('apiKeyFile has ambiguous formatting (comment marker)');
  }
  return trimmed;
}

export function validateConfig(raw) {
  if (!isPlainObject(raw)) throw new ConfigError('config must be a JSON object');
  const cfg = { ...DEFAULTS, models: { ...DEFAULTS.models }, agents: [...DEFAULTS.agents] };

  if ('enabled' in raw) {
    if (typeof raw.enabled !== 'boolean') throw new ConfigError('config.enabled must be a boolean');
    cfg.enabled = raw.enabled;
  }
  if ('endpoint' in raw) cfg.endpoint = requireString(raw, 'endpoint');
  if ('apiKeyEnv' in raw) cfg.apiKeyEnv = requireString(raw, 'apiKeyEnv');
  if ('apiKeyFile' in raw && raw.apiKeyFile !== null) {
    cfg.apiKeyFile = requireString(raw, 'apiKeyFile');
    if (!isAbsolute(cfg.apiKeyFile)) throw new ConfigError('config.apiKeyFile must be an absolute path');
  }
  if ('decisionModel' in raw) {
    cfg.decisionModel = requireString(raw, 'decisionModel');
    if (!validModelId(cfg.decisionModel)) throw new ConfigError('config.decisionModel must be provider/model[#variant]');
  }
  if ('models' in raw) {
    if (!isPlainObject(raw.models)) throw new ConfigError('config.models must be an object');
    for (const k of ['light', 'heavy']) {
      if (!validModelId(raw.models[k])) {
        throw new ConfigError(`config.models.${k} must be provider/model[#variant]`);
      }
      cfg.models[k] = raw.models[k];
    }
    for (const k of Object.keys(raw.models)) {
      if (k !== 'light' && k !== 'heavy') throw new ConfigError(`config.models.${k} is not a known choice`);
    }
  }
  if ('profiles' in raw) {
    if (!isPlainObject(raw.profiles) || Object.keys(raw.profiles).length === 0) {
      throw new ConfigError('config.profiles must be a non-empty object');
    }
    cfg.profiles = {};
    for (const [id, profile] of Object.entries(raw.profiles)) {
      // Never interpolate untrusted schema keys or values into errors.
      if (!/^(light|heavy)_(medium|high|xhigh)$/.test(id) || !isPlainObject(profile) ||
          Object.keys(profile).some(k => !['model', 'label', 'effort', 'description'].includes(k)) ||
          !['light', 'heavy'].includes(profile.label) ||
          !['medium', 'high', 'xhigh'].includes(profile.effort) ||
          id !== `${profile.label}_${profile.effort}` ||
          !validModelId(profile.model) ||
          profile.model.split('#')[1] !== profile.effort ||
          typeof profile.description !== 'string' || !profile.description.trim() ||
          profile.description.length > 4000) {
        throw new ConfigError('config.profiles contains an invalid profile');
      }
      cfg.profiles[id] = { ...profile };
    }
  }
  if ('agents' in raw) {
    if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
      throw new ConfigError('config.agents must be a non-empty array of strings');
    }
    for (const a of raw.agents) {
      if (typeof a !== 'string' || a.length === 0) throw new ConfigError('config.agents must contain non-empty strings');
    }
    cfg.agents = [...raw.agents];
  }
  if ('timeoutMs' in raw) {
    if (!Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 60000) {
      throw new ConfigError('config.timeoutMs must be an integer from 1 to 60000');
    }
    cfg.timeoutMs = raw.timeoutMs;
  }
  if ('maxTaskChars' in raw) {
    if (!Number.isInteger(raw.maxTaskChars) || raw.maxTaskChars < 1 || raw.maxTaskChars > 16000) {
      throw new ConfigError('config.maxTaskChars must be an integer from 1 to 16000');
    }
    cfg.maxTaskChars = raw.maxTaskChars;
  }
  if ('logFile' in raw && raw.logFile !== null) {
    cfg.logFile = requireString(raw, 'logFile');
    if (!isAbsolute(cfg.logFile)) throw new ConfigError('config.logFile must be an absolute path');
  }

  // Endpoint security: HTTPS required, except plain HTTP on loopback for tests.
  let url;
  try {
    url = new URL(cfg.endpoint);
  } catch {
    throw new ConfigError('config.endpoint is not a valid URL');
  }
  if (url.protocol !== 'https:' && !isLoopbackHttp(url)) {
    throw new ConfigError('config.endpoint must use HTTPS (plain HTTP only allowed for loopback test endpoints)');
  }
  if (url.username || url.password) {
    throw new ConfigError('config.endpoint must not embed credentials');
  }

  return Object.freeze(cfg);
}

// Reads and validates the JSON config at `path` (absolute). Throws ConfigError
// on unreadable/invalid files. Never includes file contents in error messages.
export function loadConfigFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new ConfigError('config path must be an absolute path');
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read config file: ${e.code ?? e.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError('config file is not valid JSON');
  }
  return validateConfig(raw);
}

/**
 * Loads configuration based on the environment.
 * - OPENCODE_DECISION_ROUTER_CONFIG unset/empty -> { enabled: false } (routing disabled, no error).
 * - Set -> the referenced file must exist and be valid; errors propagate as ConfigError.
 */
export function loadConfigFromEnv(env = process.env) {
  const p = env.OPENCODE_DECISION_ROUTER_CONFIG;
  if (typeof p !== 'string' || p.trim() === '') {
    return { enabled: false, ...DEFAULTS, models: { ...DEFAULTS.models }, agents: [...DEFAULTS.agents] };
  }
  if (!isAbsolute(p)) throw new ConfigError('OPENCODE_DECISION_ROUTER_CONFIG must be an absolute path');
  return loadConfigFile(p);
}

/**
 * Resolves the API key from env var (cfg.apiKeyEnv) or apiKeyFile.
 * Returns { key, source } or null when no key is available.
 * Never logs or includes the key in errors.
 */
export function resolveApiKey(cfg, env = process.env, readFile = readFileSync) {
  const envName = cfg.apiKeyEnv || DEFAULTS.apiKeyEnv;
  const fromEnv = env[envName];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { key: fromEnv.trim(), source: `env:${envName}` };
  }
  if (cfg.apiKeyFile) {
    if (!isAbsolute(cfg.apiKeyFile)) throw new ConfigError('config.apiKeyFile must be an absolute path');
    let raw;
    try {
      raw = readFile(cfg.apiKeyFile, 'utf8');
    } catch (e) {
      throw new ConfigError(`cannot read apiKeyFile: ${e.code ?? e.message}`);
    }
    return { key: parseApiKeyFileContent(raw), source: 'file' };
  }
  return null;
}
