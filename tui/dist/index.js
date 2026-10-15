// @bun
// src/index.tsx
import { Plugin } from "@opencode/plugin/tui";

// src/hud.tsx
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createSignal } from "solid-js";
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
  if (!entry)
    return { text: null, tone: "ok" };
  if (entry.routed) {
    const parts = [formatPercent(entry.confidence), formatSeconds(entry.latencyMs)].filter(Boolean);
    const detail = parts.length ? ` (${parts.join(", ")})` : "";
    return { text: `DR ${entry.choice}\u2192${entry.model}${detail}`, tone: "ok" };
  }
  const kept = typeof entry.model === "string" && entry.model.length > 0 ? entry.model : "model";
  return { text: `DR fallback: keep ${kept} (${entry.reason})`, tone: "warn" };
}

// src/hud.tsx
var REFRESH_EVENTS = ["session.idle", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.compaction.ended", "session.deleted"];
var POLL_MS = 2000;
var TAIL_LINES = 400;
var configPath = () => {
  const value = process.env.OPENCODE_DECISION_ROUTER_CONFIG;
  return typeof value === "string" && value.length > 0 ? value : null;
};
var readRouterLog = async () => {
  const path = configPath();
  if (!path)
    return "";
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (typeof raw?.logFile !== "string")
      return "";
    return await readFile(raw.logFile, "utf8");
  } catch {
    return "";
  }
};
var registerRoutingIndicator = async (ctx) => {
  const [entry, setEntry] = createSignal(null);
  const [enabled, setEnabled] = createSignal(configPath() !== null);
  let disposed = false;
  let refreshing = false;
  let currentSessionID = "";
  const refresh = async () => {
    setEnabled(configPath() !== null);
    if (disposed || refreshing || !configPath())
      return;
    refreshing = true;
    try {
      const text = await readRouterLog();
      const sessionID = currentSessionID;
      const next = sessionID ? latestEntryForSession(tailText(text, TAIL_LINES), sessionID) : null;
      if (!disposed)
        setEntry(next);
    } finally {
      refreshing = false;
    }
  };
  await refresh();
  const stops = REFRESH_EVENTS.map((event) => ctx.data.on(event, () => void refresh()));
  const timer = setInterval(() => void refresh(), POLL_MS);
  const removeSlot = ctx.ui.slot({
    append: "prompt.footer.status",
    render(props) {
      currentSessionID = props.sessionID ?? "";
      const indicator = () => formatIndicator(entry(), {
        enabled: enabled()
      });
      const fg = () => indicator().tone === "off" ? ctx.theme.text.muted : indicator().tone === "warn" ? ctx.theme.text.feedback.warning.base : ctx.theme.text.action.secondary.base;
      return (() => {
        var _el$ = _$createElement("text"), _el$2 = _$createElement("span");
        _$insertNode(_el$, _el$2);
        _$insert(_el$2, () => indicator().text ?? "");
        _$effect((_$p) => _$setProp(_el$, "fg", fg(), _$p));
        return _el$;
      })();
    }
  });
  return () => {
    disposed = true;
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
