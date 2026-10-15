/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal } from "solid-js"
import { readFile } from "node:fs/promises"
import { formatIndicator } from "./format.js"
import { createRouterMonitor, readRouterState } from "./read-state.js"

const REFRESH_EVENTS = [
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.compaction.ended",
  "session.deleted",
] as const

const POLL_MS = 2_000

// This is only the TUI's local configuration, not evidence of server activity.
const configPath = (): string | null => {
  const value = process.env.OPENCODE_DECISION_ROUTER_CONFIG
  return typeof value === "string" && value.length > 0 ? value : null
}

export const registerRoutingIndicator = async (ctx: Plugin.Context) => {
  const [state, setState] = createSignal<{ status: string; entry?: object | null }>({
    status: configPath() ? "pending" : "off",
  })
  const monitor = createRouterMonitor(
    (sessionID: string) => readRouterState(configPath(), sessionID, readFile),
    setState,
  )
  const stops = REFRESH_EVENTS.map((event) => ctx.data.on(event, () => void monitor.refresh()))
  const timer = setInterval(() => void monitor.refresh(), POLL_MS)
  const removeSlot = ctx.ui.slot({
    append: "prompt.footer.status",
    render(props) {
      // Track reactive slot props too, not just the initial render call.
      monitor.setSession(props.sessionID ?? "")
      createEffect(() => monitor.setSession(props.sessionID ?? ""))
      const indicator = () => formatIndicator(state().entry, state())
      const fg = () =>
        indicator().tone === "off"
          ? ctx.theme.text.muted
          : indicator().tone === "warn"
            ? ctx.theme.text.feedback.warning.base
            : ctx.theme.text.action.secondary.base
      return (
        <text fg={fg()}>
          <span>{indicator().text}</span>
        </text>
      )
    },
  })
  void monitor.refresh()

  return () => {
    monitor.dispose()
    clearInterval(timer)
    for (const stop of stops) stop()
    removeSlot()
  }
}
