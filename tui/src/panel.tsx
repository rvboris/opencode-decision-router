/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui'
import { createEffect, createSignal, onCleanup } from 'solid-js'
import { useTerminalDimensions } from '@opentui/solid'
import { readRouterStats } from './stats.js'
import { createPanelLoader, panelLines } from './panel-state.js'

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
    return <box flexDirection="column" paddingX={1} height={Math.max(3, Math.min(28, dimensions().height - 6))}>
      <text fg={ctx.theme.text.action.secondary.base}>Decision Router: статистика</text>
      <text fg={ctx.theme.text.muted}>{() => scope() === 'session' ? 'Текущая сессия' : 'Весь сохранённый журнал'}</text>
      <scrollbox focused flexGrow={1} minHeight={1} scrollY scrollX={false}>
        <text fg={ctx.theme.text.muted}>{() => panelLines(state(), scope(), !!sessionID()).join('\n')}</text>
      </scrollbox>
      <text fg={ctx.theme.text.muted}>Tab область · R обновить · ↑↓ листать · Esc закрыть</text>
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
