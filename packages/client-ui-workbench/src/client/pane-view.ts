/**
 * Which Conversation View each pane shows, and the choice between them.
 *
 * dsh keeps a Session's View (chat, or the developer-tools trajectory) in its
 * own per-Session store, persisted in the browser, and switches it from tabs
 * in its Session header. The panes do not render that header, so once a
 * tool row's Inspect action moved a Session to the trajectory, a pane had no
 * way back — and the persisted choice kept it there across reloads. So the
 * panes choose the View themselves, the way dsh's own embedded sidebar chat
 * does (`slots.views` passing `view` to `conversation.session`): every pane
 * opens on chat, and a pane header switch offers the other Views while dsh
 * lists them (the trajectory only while developer tools are on).
 * @module @psychiiii/dsh-three-window-workbench/client/pane-view
 */

import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** dsh's chat View id: every pane's default and fallback. */
export const CHAT_VIEW = 'chat'

/** dsh's developer-tools View id; it is listed only while developer tools are on. */
export const DEVELOPER_TOOLS_VIEW = 'trajectory'

/** One selectable View. */
export interface PaneViewTab {
  readonly id: string
  readonly label: string
}

/** The Views on offer and each pane Session's choice. */
export interface PaneViewsView {
  /** Views dsh lists now, in its order. */
  readonly tabs: readonly PaneViewTab[]
  /** The View a Session's pane shows: its choice when still listed, else chat. */
  viewOf(sessionId: string): string
}

/** A registered `conversation.view` entry, as far as this module reads it. */
interface ViewEntry {
  readonly options: { readonly id?: string; readonly label?: string | (() => string) }
}

/** The parts of the client context read here. */
interface ViewSources {
  readonly slots: {
    entries(name: 'conversation.view'): readonly ViewEntry[]
    subscribe(name: 'conversation.view', listener: () => void): () => void
  }
}

/**
 * The pane Views: an observable view and the one write, choosing a Session's
 * View. Choices live for this page only; a reload opens every pane on chat.
 * @param ctx - client root context.
 * @returns the observable view and the selector.
 */
export function paneViews(ctx: Context): {
  view: HostObservable<PaneViewsView>
  select: (sessionId: string, view: string) => void
} {
  const sources = ctx as unknown as ViewSources
  const choices = createSnapshotStore<Record<string, string>>({})
  const developerTools = (): boolean => ctx.get('configForms')?.developerTools.enabled.getSnapshot() ?? false
  const tabs = (): PaneViewTab[] => {
    const out: PaneViewTab[] = []
    for (const entry of sources.slots.entries('conversation.view')) {
      const id = entry.options.id
      if (id === undefined) continue
      if (id === DEVELOPER_TOOLS_VIEW && !developerTools()) continue
      const label = typeof entry.options.label === 'function' ? entry.options.label() : entry.options.label
      out.push({ id, label: label ?? id })
    }
    return out
  }
  let cachedKey = ''
  let cached: PaneViewsView | undefined
  const getSnapshot = (): PaneViewsView => {
    const current = tabs()
    const picked = choices.getSnapshot()
    const key = JSON.stringify([current, picked])
    if (cached !== undefined && key === cachedKey) return cached
    cachedKey = key
    const listed = new Set(current.map(tab => tab.id))
    cached = {
      tabs: current,
      viewOf: (sessionId) => {
        const choice = picked[sessionId]
        return choice !== undefined && listed.has(choice) ? choice : CHAT_VIEW
      },
    }
    return cached
  }
  const subscribe = (listener: () => void): (() => void) => {
    const offViews = sources.slots.subscribe('conversation.view', listener)
    const offChoices = choices.subscribe(listener)
    let offTools = ctx.get('configForms')?.developerTools.enabled.subscribe(listener)
    // The settings client may register after the workbench: follow its arrival.
    const offService = ctx.on('internal/service', (name) => {
      if (name !== 'configForms') return
      offTools?.()
      offTools = ctx.get('configForms')?.developerTools.enabled.subscribe(listener)
      listener()
    })
    return () => {
      offViews()
      offChoices()
      offTools?.()
      offService()
    }
  }
  return {
    view: { getSnapshot, subscribe },
    select: (sessionId, view) => {
      choices.update((state) => { state[sessionId] = view })
    },
  }
}
