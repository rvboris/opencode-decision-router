/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { readFile } from "node:fs/promises"
import { formatIndicator, latestEntryForSession, tailText } from "./format.js"

const REFRESH_EVENTS = [
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.compaction.ended",
  "session.deleted",
] as const

const POLL_MS = 2_000
const TAIL_LINES = 400

// Router writes decisions only when OPENCODE_DECISION_ROUTER_CONFIG is set
// (absolute path to a config whose logFile receives the jsonl lines). Absence
// of the env variable is the "DR off" state; there is no other source of truth
// inside the TUI process.
const configPath = (): string | null => {
  const value = process.env.OPENCODE_DECISION_ROUTER_CONFIG
  return typeof value === "string" && value.length > 0 ? value : null
}

const readRouterLog = async (): Promise<string> => {
  const path = configPath()
  if (!path) return ""
  try {
    const raw = JSON.parse(await readFile(path, "utf8"))
    if (typeof raw?.logFile !== "string") return ""
    return await readFile(raw.logFile, "utf8")
  } catch {
    return ""
  }
}

export const registerRoutingIndicator = async (ctx: Plugin.Context) => {
  const [entry, setEntry] = createSignal<object | null>(null)
  const [enabled, setEnabled] = createSignal(configPath() !== null)
  let disposed = false
  let refreshing = false
  // Current prompt session, updated by the slot render input on every render.
  let currentSessionID = ""

  const refresh = async () => {
    setEnabled(configPath() !== null)
    if (disposed || refreshing || !configPath()) return
    refreshing = true
    try {
      const text = await readRouterLog()
      const sessionID = currentSessionID
      const next = sessionID ? latestEntryForSession(tailText(text, TAIL_LINES), sessionID) : null
      if (!disposed) setEntry(next)
    } finally {
      refreshing = false
    }
  }

  await refresh()
  const stops = REFRESH_EVENTS.map((event) => ctx.data.on(event, () => void refresh()))
  // The router may append to the log outside of any tracked event; polling
  // keeps the indicator current (same pattern as mempalace-hud).
  const timer = setInterval(() => void refresh(), POLL_MS)
  const removeSlot = ctx.ui.slot({
    append: "prompt.footer.status",
    render(props) {
      currentSessionID = props.sessionID ?? ""
      const indicator = () => formatIndicator(entry(), { enabled: enabled() })
      const fg = () =>
        indicator().tone === "off"
          ? ctx.theme.text.muted
          : indicator().tone === "warn"
            ? ctx.theme.text.feedback.warning.base
            : ctx.theme.text.action.secondary.base
      return (
        <text fg={fg()}>
          <span>{indicator().text ?? ""}</span>
        </text>
      )
    },
  })

  return () => {
    disposed = true
    clearInterval(timer)
    for (const stop of stops) stop()
    removeSlot()
  }
}
