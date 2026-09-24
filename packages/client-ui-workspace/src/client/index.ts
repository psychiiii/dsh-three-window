/**
 * Workspace plugin, browser half. Two registrations: WorkspaceBrowser fills
 * the sidebar shell's `sidebar.workspaces` hole (the whole browsing region),
 * and WorkspacePicker fills the conversation hero's picker hole
 * (`conversation.hero.workspace` — both hero forms). Both read real Host
 * Workspaces through the global useWorkspaces hook, and each declares its
 * own `single` directory-flow child hole for the composed picker package's
 * client half (see the contract module doc). Export discipline:
 * packages/client/AGENTS.md.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the Controller service merges.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the Session root standard-hook merge.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@psychiiii/dsh-three-window-workbench/client'
import type { WindowsSnapshot, WorkspaceBrowserInjected, WorkspacePickerInjected } from './contract/slots.ts'
import { NO_WINDOWS } from './tree.ts'
import { UiWorkspaceService } from './navigation.ts'
import { createWorkspaceViewStore } from './stores.ts'
import { WorkspaceBrowser } from './rows/WorkspaceBrowser.tsx'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import { en, zh, type WorkspaceKey } from './locales.ts'

export type { UiWorkspace } from './navigation.ts'
export type {
  DirectoryFlowOwnerProps, DirectoryFlowSlotName, DirectoryPickingHooks, DirectoryPickingInjected,
  WorkspaceBrowserInjected, WorkspaceBrowserProps, WorkspacePickerInjected, WorkspacePickerProps,
} from './contract/slots.ts'
export type { WorkspaceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** Selector hook over the pure Workspace Controller snapshot. */
    useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
  }

  interface LocaleNamespaceMap {
    /** The workspace browsing region and pick/create flow copy. */
    workspace: WorkspaceKey
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    workspaceOperation: unknown
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'workspace'

/** The part of the workbench the browser reads; absent in compositions without one. */
interface WorkbenchWindows {
  getSnapshot(): {
    focusedWorkspaceId: WorkspaceId | undefined
    layouts: WindowsSnapshot['layouts']
    limitPrompt: { workspaceId: WorkspaceId; index: 0 | 1 | 2 } | undefined
  }
  subscribe(listener: () => void): () => void
  ownsWorkspaceEntry(): boolean
  createWindow(index: number, workspaceId?: WorkspaceId): Promise<unknown>
  restorePast(sessionId: string): void
  planAdoption(sessionId: string, index?: number): { workspaceId: WorkspaceId; index: 0 | 1 | 2 }
  adoptSession(sessionId: string, index?: number): Promise<unknown>
  resolveLimitPrompt(sessionId: string): Promise<unknown>
  dismissLimitPrompt(): void
}

const INACTIVE_WINDOWS: WindowsSnapshot = { ...NO_WINDOWS, limitPrompt: undefined }

function requireWorkbench(ctx: Context): WorkbenchWindows {
  const workbench = ctx.get('workbench') as WorkbenchWindows | undefined
  if (workbench === undefined) throw new Error('ui-workspace: this composition has no three-window workbench')
  return workbench
}

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * the ui-sidebar / ui-conversation applies, whose activation order relative
 * to this one is NOT constrained: dsh.client.inject edges are informational
 * (loading/prefetch metadata, never apply sequencing) and neither owner
 * provides a waitable service. apply therefore depends on each slot
 * declaration through `slots.inject()` instead of assuming order.
 */
export const inject = [
  'slots', 'sessions', 'sessionRetention', 'workspaces', 'locale', 'remote', 'remote.directoryPicker', 'layout',
]

/**
 * Register the browser and picker once their slot declarations are on the
 * ledger. Inject factories return plain callbacks; data reads use the
 * framework's global hooks.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces
  const uiWorkspace = new UiWorkspaceService(
    ctx, ctx.remote.directoryPicker, workspaces, sessions)
  ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace: dictionaries')

  const searchSessions: WorkspaceBrowserInjected['searchSessions'] = async (query, signal) => {
    const result = await sessions.search(query, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  // Stable per-surface occupancy sources (the renderer's hook cache keys by
  // source identity): true while the surface's directory-flow hole is filled.
  const flowSource = (hole: 'sidebar.workspaces.directoryFlow' | 'conversation.hero.workspace.directoryFlow'): HostObservable<boolean> => ({
    getSnapshot: () => ctx.slots.entries(hole).length > 0,
    subscribe: listener => ctx.slots.subscribe(hole, listener),
  })
  const browserFlowSource = flowSource('sidebar.workspaces.directoryFlow')
  const hostInfo: HostObservable<RemoteHostFacts> = {
    getSnapshot: () => ctx.remote.$host,
    subscribe: listener => ctx.on('connection/reset', listener),
  }
  const pickerFlowSource = flowSource('conversation.hero.workspace.directoryFlow')
  // Stable per workbench publish: the renderer's selector cache compares identity.
  let windowsSource: object | undefined
  let windowsSnapshot: WindowsSnapshot = INACTIVE_WINDOWS
  const readWindows = (): WindowsSnapshot => {
    const workbench = ctx.get('workbench') as WorkbenchWindows | undefined
    if (workbench === undefined) return INACTIVE_WINDOWS
    const snapshot = workbench.getSnapshot()
    if (snapshot === windowsSource) return windowsSnapshot
    windowsSource = snapshot
    windowsSnapshot = {
      active: workbench.ownsWorkspaceEntry(),
      focusedWorkspaceId: snapshot.focusedWorkspaceId,
      layouts: snapshot.layouts,
      limitPrompt: snapshot.limitPrompt === undefined
        ? undefined
        : { workspaceId: snapshot.limitPrompt.workspaceId, index: snapshot.limitPrompt.index },
    }
    return windowsSnapshot
  }
  const openSession: WorkspaceBrowserInjected['open'] = (sessionId) => {
    uiWorkspace.openSession(sessionId)
  }
  const browserInjected = (): WorkspaceBrowserInjected => ({
    // Explicit group actions keep their target; unscoped New Session inherits
    // the focused Workspace before the current Session's and the recent one.
    startSession: (workspaceId) => { uiWorkspace.startSession(workspaceId) },
    focusWorkspace: workspaceId => uiWorkspace.focusWorkspace(workspaceId),
    open: openSession,
    searchSessions,
    searchResultLimit: sessions.searchResultLimit,
    renameSession: async (sessionId, title) => {
      const result = await ctx.sessionRetention.using(
        sessionId,
        { source: 'workspaceOperation' },
        reference => reference.binding.session.rename(title),
      )
      if (!result.ok) throw new Error(result.error.message)
    },
    forkSession: (sessionId) => {
      uiWorkspace.forkSession(sessionId)
        .catch(() => {
          // Fork or child-rename failure keeps the current selection.
        })
    },
    renameWorkspace: async (workspaceId, title) => { await workspaces.rename(workspaceId, title) },
    deleteWorkspace: async (workspaceId) => { await workspaces.delete(workspaceId) },
    insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
      await workspaces.insertBefore(workspaceId, beforeWorkspaceId)
    },
    archiveSession: async (sessionId) => { await uiWorkspace.archiveSession(sessionId) },
    unarchiveSession: async (sessionId) => { await uiWorkspace.unarchiveSession(sessionId) },
    createWindow: async (index, workspaceId) => { await requireWorkbench(ctx).createWindow(index, workspaceId) },
    restorePast: (sessionId) => { requireWorkbench(ctx).restorePast(sessionId) },
    planAdoption: (sessionId, index) => {
      try {
        return { ok: true, index: requireWorkbench(ctx).planAdoption(sessionId, index).index }
      } catch (error: unknown) {
        const code = (error as { code?: unknown }).code
        if (typeof code !== 'string') throw error
        return { ok: false, code }
      }
    },
    adoptSession: async (sessionId, index) => { await requireWorkbench(ctx).adoptSession(sessionId, index) },
    resolveLimit: async (sessionId) => { await requireWorkbench(ctx).resolveLimitPrompt(sessionId) },
    dismissLimit: () => { requireWorkbench(ctx).dismissLimitPrompt() },
    createWorkspace: input => workspaces.create(input),
    hooks: {
      directoryFlow: browserFlowSource,
      hostInfo,
      windows: {
        getSnapshot: readWindows,
        subscribe: (listener) => {
          const workbench = ctx.get('workbench') as WorkbenchWindows | undefined
          if (workbench === undefined) return () => {}
          return workbench.subscribe(listener)
        },
      },
    },
  })
  const pickerInjected = (): WorkspacePickerInjected => ({
    createWorkspace: input => workspaces.create(input),
    focusWorkspace: workspaceId => uiWorkspace.focusWorkspace(workspaceId),
    hooks: { directoryFlow: pickerFlowSource },
  })
  // Each registration declares its directory-flow child in the same call;
  // slot injection follows both the owner and declaration HMR lifetimes.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      children: {
        'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
        'sidebar.session.row.leading': { kind: 'list', scope: 'root' },
        'sidebar.session.row.hover': { kind: 'list', scope: 'root' },
      },
      store: createWorkspaceViewStore(),
      inject: browserInjected,
      locale: NS,
    },
    WorkspaceBrowser,
  ))
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register(
    {
      name: 'conversation.hero.workspace',
      children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } },
      inject: pickerInjected,
      locale: NS,
    },
    WorkspacePicker,
  ))
}
