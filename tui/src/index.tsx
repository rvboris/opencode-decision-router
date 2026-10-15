/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { registerRoutingIndicator } from "./hud"

export default Plugin.define({
  id: "rvboris.decision-router-indicator",
  setup: registerRoutingIndicator,
})
