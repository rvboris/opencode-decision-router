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
var safeLabel = (value, maxLength) => typeof value === "string" && value.length <= maxLength && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
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
  if (!safeLabel(value.profile, 64))
    delete value.profile;
  if (!safeLabel(value.effort, 32))
    delete value.effort;
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
function formatIndicator(entry, state = {}) {
  if (state.enabled === false)
    return { text: "DR \xB7 \u0432\u044B\u043A\u043B", tone: "off" };
  const statuses = {
    off: ["DR \xB7 \u0432\u044B\u043A\u043B", "off"],
    pending: ["DR \xB7 \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435", "off"],
    "config-unreadable": ["DR \xB7 \u043A\u043E\u043D\u0444\u0438\u0433 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D", "warn"],
    "config-invalid": ["DR \xB7 \u043E\u0448\u0438\u0431\u043A\u0430 \u043A\u043E\u043D\u0444\u0438\u0433\u0430", "warn"],
    "log-unconfigured": ["DR \xB7 \u043B\u043E\u0433 \u043D\u0435 \u0437\u0430\u0434\u0430\u043D", "warn"],
    "log-missing": ["DR \xB7 \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435", "off"],
    "log-unreadable": ["DR \xB7 \u043B\u043E\u0433 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D", "warn"]
  };
  const diagnostic = statuses[state.status];
  if (diagnostic)
    return { text: diagnostic[0], tone: diagnostic[1] };
  if (!entry)
    return { text: "DR \xB7 \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435", tone: "off" };
  const agent = typeof entry.agent === "string" && entry.agent.trim() ? entry.agent.trim() : "\u0430\u0433\u0435\u043D\u0442 \u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u0435\u043D";
  if (entry.routed) {
    const effort = safeLabel(entry.effort, 32) ? `/${entry.effort}` : "";
    return { text: `DR \xB7 ${agent} \u2192 ${entry.choice}${effort}`, tone: "ok" };
  }
  return { text: `DR \xB7 ${agent} \xB7 fallback`, tone: "warn" };
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

// src/panel.tsx
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect2 } from "@opentui/solid";
import { insert as _$insert2 } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode2 } from "@opentui/solid";
import { setProp as _$setProp2 } from "@opentui/solid";
import { createElement as _$createElement2 } from "@opentui/solid";
import { createEffect as createEffect2, createSignal as createSignal2, onCleanup } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";

// src/stats.js
import { createReadStream } from "fs";
import { readFile as readFile2 } from "fs/promises";
import { createInterface } from "readline";
var emptySummary = () => ({ total: 0, successful: 0, fallback: 0, models: [], profiles: [], agents: [] });
var percent = (count, total) => total ? Math.round(count / total * 1000) / 10 : 0;
var profileName = (entry) => `${entry.choice}/${typeof entry.effort === "string" && entry.effort ? entry.effort : "effort \u043D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D"}`;
function createAccumulator() {
  const state = { total: 0, successful: 0, fallback: 0, models: new Map, profiles: new Map, agents: new Map };
  return {
    add(entry) {
      state.total++;
      if (!entry.routed) {
        state.fallback++;
        return;
      }
      state.successful++;
      const profile = profileName(entry);
      state.models.set(entry.choice, (state.models.get(entry.choice) ?? 0) + 1);
      state.profiles.set(profile, (state.profiles.get(profile) ?? 0) + 1);
      const agent = typeof entry.agent === "string" && entry.agent.trim() ? entry.agent : "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u043E";
      let stats = state.agents.get(agent);
      if (!stats)
        state.agents.set(agent, stats = { count: 0, profiles: new Map });
      stats.count++;
      stats.profiles.set(profile, (stats.profiles.get(profile) ?? 0) + 1);
    },
    result() {
      return {
        total: state.total,
        successful: state.successful,
        fallback: state.fallback,
        models: [...state.models].map(([name, count]) => ({ name, count, percent: percent(count, state.successful) })),
        profiles: [...state.profiles].map(([name, count]) => ({ name, count, percent: percent(count, state.successful) })),
        agents: [...state.agents].map(([name, stats]) => ({
          name,
          count: stats.count,
          percent: percent(stats.count, state.successful),
          profiles: [...stats.profiles].map(([name2, count]) => ({ name: name2, count, percent: percent(count, stats.count) }))
        }))
      };
    }
  };
}
function recognizedLine(line) {
  if (!line.trim())
    return { kind: "empty" };
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "invalid" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { kind: "foreign" };
  if (typeof value.routed !== "boolean" || typeof value.reason !== "string")
    return { kind: "foreign" };
  const entry = parseRouterLine(line);
  return entry ? { kind: "entry", entry } : { kind: "invalid" };
}
function dedupeKey(entry) {
  return typeof entry.sessionID === "string" && entry.sessionID.length > 0 && typeof entry.eventId === "string" && entry.eventId.length > 0 ? `${entry.sessionID}\x00${entry.eventId}` : null;
}
async function readRouterStats({ configPath: configPath2, sessionID, readFileImpl = readFile2, createReadStreamImpl = createReadStream } = {}) {
  const empty = emptySummary();
  if (!configPath2)
    return { status: "off", session: empty, all: empty, invalidLines: 0 };
  let text;
  try {
    text = await readFileImpl(configPath2, "utf8");
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "config-missing" : "config-error", session: empty, all: empty, invalidLines: 0 };
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return { status: "config-error", session: empty, all: empty, invalidLines: 0 };
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || config.enabled !== undefined && typeof config.enabled !== "boolean" || config.logFile !== undefined && config.logFile !== null && typeof config.logFile !== "string") {
    return { status: "config-error", session: empty, all: empty, invalidLines: 0 };
  }
  if (config.enabled === false)
    return { status: "off", session: empty, all: empty, invalidLines: 0 };
  if (typeof config.logFile !== "string" || !config.logFile.trim()) {
    return { status: "config-error", session: empty, all: empty, invalidLines: 0 };
  }
  let stream;
  try {
    stream = createReadStreamImpl(config.logFile, { encoding: "utf8" });
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "log-missing" : "log-error", session: empty, all: empty, invalidLines: 0 };
  }
  const all = createAccumulator();
  const session = createAccumulator();
  let invalidLines = 0;
  const seen = new Set;
  try {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      const parsed = recognizedLine(line);
      if (parsed.kind === "invalid") {
        invalidLines++;
        continue;
      }
      if (parsed.kind !== "entry")
        continue;
      const entry = parsed.entry;
      const key = dedupeKey(entry);
      if (key && seen.has(key))
        continue;
      if (key)
        seen.add(key);
      all.add(entry);
      if (typeof sessionID === "string" && entry.sessionID === sessionID)
        session.add(entry);
    }
  } catch (error) {
    if (typeof stream.destroy === "function")
      stream.destroy();
    return { status: error?.code === "ENOENT" ? "log-missing" : "log-error", session: empty, all: empty, invalidLines };
  }
  return { status: "ready", session: session.result(), all: all.result(), invalidLines };
}

// src/panel-state.js
var label = (value) => String(value ?? "\u043D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 96);
var row = (item) => `${label(item.name)} \u2014 ${item.count} \xB7 ${Number.isFinite(item.percent) ? item.percent.toFixed(1) : "0.0"}%`;
var errors = {
  off: "Decision Router \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D",
  "config-missing": "\u041A\u043E\u043D\u0444\u0438\u0433 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D",
  "config-error": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C \u043A\u043E\u043D\u0444\u0438\u0433",
  "log-missing": "\u0416\u0443\u0440\u043D\u0430\u043B \u0435\u0449\u0451 \u043D\u0435 \u0441\u043E\u0437\u0434\u0430\u043D",
  "log-error": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C \u0436\u0443\u0440\u043D\u0430\u043B"
};
function panelLines(state, scope, hasSession = true) {
  if (state.status === "loading")
    return ["\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430\u2026"];
  if (state.status !== "ready")
    return [errors[state.status] ?? "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0443"];
  if (scope === "session" && !hasSession)
    return ["\u041D\u0435\u0442 \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u0441\u0435\u0441\u0441\u0438\u0438. Tab \u2014 \u0432\u0435\u0441\u044C \u0436\u0443\u0440\u043D\u0430\u043B."];
  const summary = state[scope];
  const lines = [
    `\u0423\u0441\u043F\u0435\u0448\u043D\u043E: ${summary.successful} \xB7 fallback: ${summary.fallback}`,
    "\u041F\u0440\u043E\u0446\u0435\u043D\u0442\u044B \u2014 \u043E\u0442 \u0443\u0441\u043F\u0435\u0448\u043D\u044B\u0445 \u0440\u0435\u0448\u0435\u043D\u0438\u0439."
  ];
  if (!summary.successful)
    lines.push("\u0423\u0441\u043F\u0435\u0448\u043D\u044B\u0445 \u0440\u0435\u0448\u0435\u043D\u0438\u0439 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442.");
  else {
    lines.push("", "\u041C\u043E\u0434\u0435\u043B\u0438", ...summary.models.map(row), "", "\u041F\u0440\u043E\u0444\u0438\u043B\u0438 \xB7 \u043C\u043E\u0434\u0435\u043B\u044C / effort", ...summary.profiles.map(row), "", "\u0410\u0433\u0435\u043D\u0442\u044B");
    for (const agent of summary.agents) {
      lines.push(row(agent), ...agent.profiles.map((profile) => `  ${row(profile)}`));
    }
    lines.push("  \u0414\u043E\u043B\u0438 \u043F\u0440\u043E\u0444\u0438\u043B\u0435\u0439 \u0430\u0433\u0435\u043D\u0442\u0430 \u2014 \u0432\u043D\u0443\u0442\u0440\u0438 \u0430\u0433\u0435\u043D\u0442\u0430.");
  }
  lines.push("", `\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0445 \u0441\u0442\u0440\u043E\u043A \u0432\u043E \u0432\u0441\u0451\u043C \u0436\u0443\u0440\u043D\u0430\u043B\u0435: ${state.invalidLines}`, "\u041F\u0440\u043E\u043F\u0443\u0441\u043A\u0438 \u043D\u0435 \u0436\u0443\u0440\u043D\u0430\u043B\u0438\u0440\u0443\u044E\u0442\u0441\u044F.", "\u0412\u0435\u0441\u044C \u0436\u0443\u0440\u043D\u0430\u043B \u2014 \u0442\u043E\u043B\u044C\u043A\u043E \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0435 \u0437\u0430\u043F\u0438\u0441\u0438.", "\u042D\u0442\u043E \u0440\u0435\u0448\u0435\u043D\u0438\u044F, \u043D\u0435 \u0442\u043E\u043A\u0435\u043D\u044B \u0438\u043B\u0438 \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C.");
  return lines;
}
function createPanelLoader(read, publish) {
  let version = 0;
  let disposed = false;
  return {
    async refresh(sessionID) {
      if (disposed)
        return;
      const current = ++version;
      publish({ status: "loading" });
      let result;
      try {
        result = await read(sessionID);
      } catch {
        result = { status: "log-error" };
      }
      if (!disposed && current === version)
        publish(result);
    },
    dispose() {
      disposed = true;
      version++;
    }
  };
}

// src/panel.tsx
function registerRoutingStats(ctx) {
  let closeActive;
  const Panel = () => {
    const dimensions = useTerminalDimensions();
    const [scope, setScope] = createSignal2("session");
    const [state, setState] = createSignal2({
      status: "loading"
    });
    const sessionID = () => {
      const route = ctx.ui.router.current();
      return route.type === "session" ? route.sessionID : "";
    };
    const loader = createPanelLoader((sessionID2) => readRouterStats({
      configPath: process.env.OPENCODE_DECISION_ROUTER_CONFIG || null,
      sessionID: sessionID2
    }), setState);
    const refresh = () => {
      loader.refresh(sessionID());
    };
    createEffect2(() => {
      loader.refresh(sessionID());
    });
    onCleanup(() => loader.dispose());
    ctx.keymap.layer(() => ({
      mode: "global",
      priority: 100,
      commands: [{
        bind: "tab",
        title: "\u041E\u0431\u043B\u0430\u0441\u0442\u044C \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0438",
        run: () => {
          setScope(scope() === "session" ? "all" : "session");
        }
      }, {
        bind: "r",
        title: "\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0443",
        run: refresh
      }, {
        bind: "escape",
        title: "\u0417\u0430\u043A\u0440\u044B\u0442\u044C \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0443",
        run: () => ctx.ui.dialog.clear()
      }]
    }));
    return (() => {
      var _el$ = _$createElement2("box"), _el$2 = _$createElement2("text"), _el$4 = _$createElement2("text"), _el$5 = _$createElement2("scrollbox"), _el$6 = _$createElement2("text"), _el$7 = _$createElement2("text");
      _$insertNode2(_el$, _el$2);
      _$insertNode2(_el$, _el$4);
      _$insertNode2(_el$, _el$5);
      _$insertNode2(_el$, _el$7);
      _$setProp2(_el$, "flexDirection", "column");
      _$setProp2(_el$, "paddingX", 1);
      _$insertNode2(_el$2, _$createTextNode(`Decision Router: \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430`));
      _$insert2(_el$4, () => scope() === "session" ? "\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F" : "\u0412\u0435\u0441\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0439 \u0436\u0443\u0440\u043D\u0430\u043B");
      _$insertNode2(_el$5, _el$6);
      _$setProp2(_el$5, "focused", true);
      _$setProp2(_el$5, "flexGrow", 1);
      _$setProp2(_el$5, "minHeight", 1);
      _$setProp2(_el$5, "scrollY", true);
      _$setProp2(_el$5, "scrollX", false);
      _$insert2(_el$6, () => panelLines(state(), scope(), !!sessionID()).join(`
`));
      _$insertNode2(_el$7, _$createTextNode(`Tab \u043E\u0431\u043B\u0430\u0441\u0442\u044C \xB7 R \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u044C \xB7 \u2191\u2193 \u043B\u0438\u0441\u0442\u0430\u0442\u044C \xB7 Esc \u0437\u0430\u043A\u0440\u044B\u0442\u044C`));
      _$effect2((_p$) => {
        var _v$ = Math.max(3, Math.min(28, dimensions().height - 6)), _v$2 = ctx.theme.text.action.secondary.base, _v$3 = ctx.theme.text.muted, _v$4 = ctx.theme.text.muted, _v$5 = ctx.theme.text.muted;
        _v$ !== _p$.e && (_p$.e = _$setProp2(_el$, "height", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp2(_el$2, "fg", _v$2, _p$.t));
        _v$3 !== _p$.a && (_p$.a = _$setProp2(_el$4, "fg", _v$3, _p$.a));
        _v$4 !== _p$.o && (_p$.o = _$setProp2(_el$6, "fg", _v$4, _p$.o));
        _v$5 !== _p$.i && (_p$.i = _$setProp2(_el$7, "fg", _v$5, _p$.i));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined,
        i: undefined
      });
      return _el$;
    })();
  };
  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: "decision-router.stats",
      title: "Decision Router: \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430",
      group: "Decision Router",
      palette: true,
      run: () => {
        closeActive = () => ctx.ui.dialog.clear();
        ctx.ui.dialog.show(() => _$createComponent(Panel, {}), () => {
          closeActive = undefined;
        });
        ctx.ui.dialog.set({
          size: "medium"
        });
      }
    }]
  }));
  return () => {
    closeActive?.();
  };
}

// src/index.tsx
var src_default = Plugin.define({
  id: "rvboris.decision-router-indicator",
  setup: async (ctx) => {
    const stopIndicator = await registerRoutingIndicator(ctx);
    const stopStats = registerRoutingStats(ctx);
    return () => {
      stopStats();
      stopIndicator();
    };
  }
});
export {
  src_default as default
};
