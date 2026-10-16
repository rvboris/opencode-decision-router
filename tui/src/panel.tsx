/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui'
import { createEffect, createSignal, For, onCleanup } from 'solid-js'
import { useTerminalDimensions } from '@opentui/solid'
import { readRouterStats } from './stats.js'
import { createPanelLoader, panelRows } from './panel-state.js'
import { scopeTabs } from './panel-presentation.js'

export function registerRoutingStats(ctx: Plugin.Context) {
  let closeActive: (() => void) | undefined
  const Panel = () => {
    const dimensions = useTerminalDimensions()
    const [scope, setScope] = createSignal<'session' | 'all'>('session')
    const [state, setState] = createSignal<any>({ status: 'loading' })
    const sessionID = () => {
      const route = ctx.ui.router.current()
      return route.type === 'session' ? route.sessionID : ''
    }
    const loader = createPanelLoader(
      (sessionID: string) => readRouterStats({
        configPath: process.env.OPENCODE_DECISION_ROUTER_CONFIG || null, sessionID,
      }), setState,
    )
    const refresh = () => { void loader.refresh(sessionID()) }
    createEffect(() => { void loader.refresh(sessionID()) })
    onCleanup(() => loader.dispose())
    ctx.keymap.layer(() => ({
      mode: 'global', priority: 100,
      commands: [
        { bind: 'tab', title: 'Область статистики', run: () => { setScope(scope() === 'session' ? 'all' : 'session') } },
        { bind: 'r', title: 'Обновить статистику', run: refresh },
        { bind: 'escape', title: 'Закрыть статистику', run: () => ctx.ui.dialog.clear() },
      ],
    }))
    const [contentWidth, setContentWidth] = createSignal(24)
    const color = (tone: string) => tone === 'light' ? ctx.theme.text.action.secondary.base
      : tone === 'heavy' || tone === 'heading' ? ctx.theme.text.action.primary.base
      : tone === 'warning' ? ctx.theme.text.feedback.warning.base
      : tone === 'base' ? ctx.theme.text.base : ctx.theme.text.muted
    return <box flexDirection="column" paddingX={1} height={Math.max(3, Math.min(28, dimensions().height - 6))}>
      <text fg={ctx.theme.text.base} flexShrink={0}>Decision Router · статистика</text>
      <box flexDirection="row" flexWrap="wrap" flexShrink={0} columnGap={2}>
        <For each={scopeTabs(scope(), contentWidth())}>{tab =>
          <text fg={tab.active ? ctx.theme.text.action.primary.base : ctx.theme.text.muted}>{tab.text}</text>
        }</For>
      </box>
      <scrollbox focused flexGrow={1} minHeight={1} scrollY scrollX={false}>
        <box flexDirection="column" width="100%" paddingRight={1} onSizeChange={function () { setContentWidth(Math.max(1, Math.floor(this.width) - 1)) }}>
          <For each={panelRows(state(), scope(), !!sessionID(), contentWidth())}>{row =>
            <text fg={color(row.tone)} wrapMode="word" flexShrink={0}>{row.text || ' '}</text>
          }</For>
        </box>
      </scrollbox>
      <text fg={ctx.theme.text.muted} flexShrink={0} wrapMode="word">Tab область · R обновить · ↑↓ листать · Esc закрыть</text>
    </box>
  }
  ctx.keymap.layer(() => ({ mode: 'global', commands: [{
    id: 'decision-router.stats', title: 'Decision Router: статистика',
    group: 'Decision Router', palette: true,
    run: () => {
      closeActive = () => ctx.ui.dialog.clear()
      ctx.ui.dialog.show(() => <Panel />, () => { closeActive = undefined })
      ctx.ui.dialog.set({ size: 'medium' })
    },
  }] }))
  return () => { closeActive?.() }
}
