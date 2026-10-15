// @bun
// src/index.tsx
import { Plugin } from "@opencode/plugin/tui";

// src/hud.tsx
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createEffect, createSignal } from "solid-js";
import { readFile } from "fs/promises";

// src/format.js
function parseRouterLine(line) {
  if (typeof line !== "string")
    return null;
  const trimmed = line.trim();
  if (!trimmed)
    return null;
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  if (typeof value.sessionID !== "string" || value.sessionID.length === 0)
    return null;
  if (typeof value.routed !== "boolean")
    return null;
  if (typeof value.reason !== "string" || value.reason.length === 0)
    return null;
  if (value.routed) {
    if (typeof value.choice !== "string" || value.choice.length === 0)
      return null;
    if (typeof value.model !== "string" || value.model.length === 0)
      return null;
  }
  if (value.latencyMs !== undefined && value.latencyMs !== null && typeof value.latencyMs !== "number")
    return null;
  return value;
}
function latestEntryForSession(text, sessionID) {
  if (typeof text !== "string" || !sessionID)
    return null;
  let latest = null;
  for (const line of text.split(`
`)) {
    const entry = parseRouterLine(line);
    if (entry && entry.sessionID === sessionID)
      latest = entry;
  }
  return latest;
}
function tailText(text, maxLines = 200) {
  if (typeof text !== "string")
    return "";
  const lines = text.split(`
`);
  while (lines.length > 0 && lines[lines.length - 1] === "")
    lines.pop();
  return lines.slice(Math.max(0, lines.length - maxLines)).join(`
`);
}
function formatSeconds(latencyMs) {
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs))
    return null;
  return `${(latencyMs / 1000).toFixed(1)}s`;
}
function formatPercent(confidence) {
  if (typeof confidence !== "number" || !Number.isFinite(confidence))
    return null;
  const pct = confidence <= 1 ? confidence * 100 : confidence;
  return `${Math.round(pct)}%`;
}
function formatIndicator(entry, state = {}) {
  if (state.enabled === false)
    return { text: "DR off", tone: "off" };
  const statuses = {
    off: ["DR off", "off"],
    pending: ["DR: \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0440\u0435\u0448\u0435\u043D\u0438\u044F", "off"],
    "config-unreadable": ["DR: \u043A\u043E\u043D\u0444\u0438\u0433 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D", "warn"],
    "config-invalid": ["DR: \u043E\u0448\u0438\u0431\u043A\u0430 \u043A\u043E\u043D\u0444\u0438\u0433\u0430", "warn"],
    "log-unconfigured": ["DR: logFile \u043D\u0435 \u0437\u0430\u0434\u0430\u043D", "warn"],
    "log-missing": ["DR: \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0440\u0435\u0448\u0435\u043D\u0438\u044F \xB7 \u043D\u0435\u0442 \u043B\u043E\u0433\u0430", "off"],
    "log-unreadable": ["DR: \u043B\u043E\u0433 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D", "warn"]
  };
  const diagnostic = statuses[state.status];
  if (diagnostic)
    return { text: diagnostic[0], tone: diagnostic[1] };
  if (!entry)
    return { text: "DR: \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0440\u0435\u0448\u0435\u043D\u0438\u044F", tone: "off" };
  if (entry.routed) {
    const parts = [formatPercent(entry.confidence), formatSeconds(entry.latencyMs)].filter(Boolean);
    const detail = parts.length ? ` (${parts.join(", ")})` : "";
    return { text: `DR ${entry.choice}\u2192${entry.model}${detail}`, tone: "ok" };
  }
  const kept = typeof entry.model === "string" && entry.model.length > 0 ? entry.model : "model";
  return { text: `DR fallback: keep ${kept} (${entry.reason})`, tone: "warn" };
}

// src/read-state.js
async function readRouterState(configPath, sessionID, readFile) {
  if (!configPath)
    return { status: "off" };
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return { status: "config-unreadable" };
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return { status: "config-invalid" };
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || config.enabled !== undefined && typeof config.enabled !== "boolean") {
    return { status: "config-invalid" };
  }
  if (config.enabled === false)
    return { status: "off" };
  if (typeof config.logFile !== "string" || !config.logFile.trim()) {
    return { status: "log-unconfigured" };
  }
  try {
    text = await readFile(config.logFile, "utf8");
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "log-missing" : "log-unreadable" };
  }
  return { status: "ready", entry: latestEntryForSession(tailText(text, 400), sessionID) };
}
function createRouterMonitor(read, publish) {
  let sessionID = "";
  let generation = 0;
  let inFlight = null;
  let disposed = false;
  const refresh = async () => {
    if (disposed || inFlight === generation)
      return;
    const version = generation;
    const session = sessionID;
    inFlight = version;
    try {
      const state = await read(session);
      if (!disposed && version === generation)
        publish(state);
    } finally {
      if (inFlight === version)
        inFlight = null;
    }
  };
  return {
    refresh,
    setSession(next) {
      if (disposed || next === sessionID)
        return;
      sessionID = next;
      generation++;
      publish({ status: "pending" });
      refresh();
    },
    dispose() {
      disposed = true;
      generation++;
    }
  };
}

// src/hud.tsx
var REFRESH_EVENTS = ["session.idle", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.compaction.ended", "session.deleted"];
var POLL_MS = 2000;
var configPath = () => {
  const value = process.env.OPENCODE_DECISION_ROUTER_CONFIG;
  return typeof value === "string" && value.length > 0 ? value : null;
};
var registerRoutingIndicator = async (ctx) => {
  const [state, setState] = createSignal({
    status: configPath() ? "pending" : "off"
  });
  const monitor = createRouterMonitor((sessionID) => readRouterState(configPath(), sessionID, readFile), setState);
  const stops = REFRESH_EVENTS.map((event) => ctx.data.on(event, () => void monitor.refresh()));
  const timer = setInterval(() => void monitor.refresh(), POLL_MS);
  const removeSlot = ctx.ui.slot({
    append: "prompt.footer.status",
    render(props) {
      monitor.setSession(props.sessionID ?? "");
      createEffect(() => monitor.setSession(props.sessionID ?? ""));
      const indicator = () => formatIndicator(state().entry, state());
      const fg = () => indicator().tone === "off" ? ctx.theme.text.muted : indicator().tone === "warn" ? ctx.theme.text.feedback.warning.base : ctx.theme.text.action.secondary.base;
      return (() => {
        var _el$ = _$createElement("text"), _el$2 = _$createElement("span");
        _$insertNode(_el$, _el$2);
        _$insert(_el$2, () => indicator().text);
        _$effect((_$p) => _$setProp(_el$, "fg", fg(), _$p));
        return _el$;
      })();
    }
  });
  monitor.refresh();
  return () => {
    monitor.dispose();
    clearInterval(timer);
    for (const stop of stops)
      stop();
    removeSlot();
  };
};

// src/index.tsx
var src_default = Plugin.define({
  id: "rvboris.decision-router-indicator",
  setup: registerRoutingIndicator
});
export {
  src_default as default
};
