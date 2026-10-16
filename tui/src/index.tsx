/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { registerRoutingIndicator } from "./hud"
import { registerRoutingStats } from "./panel"

export default Plugin.define({
  id: "rvboris.decision-router-indicator",
  setup: async (ctx) => {
    const stopIndicator = await registerRoutingIndicator(ctx)
    const stopStats = registerRoutingStats(ctx)
    return () => { stopStats(); stopIndicator() }
  },
})
