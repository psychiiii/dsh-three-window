/**
 * Bind three ordinary Sessions from the Session list and Host `session.create`.
 * Pane order is Config `windows` order, never "the three most recent ids".
 *
 * Every pass targets the focused Workspace, so entering a Workspace creates its
 * three windows once and reuses them from then on. A pane keeps the Session it
 * is bound to — or, before this page bound the Workspace, the Session stored as
 * its last binding — while that Session is listed, usable, and still runs the
 * pane's preset; only an empty pane falls back to the most recently updated
 * matching Session that is not a past window, and only then is one created.
 * So a list update never undoes an explicit replacement. A fresh page restores
 * the Workspace the last page entered; the recency pick inside
 * {@link resolveProjectRoot} is the explicit first-entry fallback, running only
 * while there is no restorable focus. Other Workspaces whose three stored
 * Sessions are all still valid are bound too, without creating anything, so
 * their sidebar tags survive a reload.
 * @module @psychiiii/dsh-three-window-workbench/bootstrap
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { RemoteHostFacts, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WORKBENCH_WINDOW_COUNT, type ResolvedWorkbenchConfig, type WorkbenchWindowConfig } from '../config.ts'
import {
  resolveProjectRoot, sameProjectPath,
  type ProjectRootRequest, type ProjectRootSpec,
} from '../project-root.ts'
import { projectedPreset, type Workbench } from './service.ts'
import type { WorkbenchWindow } from './windows.ts'

/** Client Remote face bootstrap reads for Host home and preset selection. */
interface RemoteHome {
  readonly $host: RemoteHostFacts
  readonly agentPresets: {
    select(sessionId: SessionId, agentPreset: string): Promise<RemoteResult<string>>
  }
}

/**
 * Subscribe to Session and Workspace lists and keep three panes bound.
 * @param ctx - Client context carrying `sessions`, `workspaces`, and `remote`.
 * @param workbench - the workbench service to bind.
 * @param config - resolved windows; caller skips this when `windows` is empty.
 * @returns disposer aborting in-flight reconcile.
 */
export function watchWorkbenchPanes(
  ctx: Context,
  workbench: Workbench,
  config: ResolvedWorkbenchConfig,
): () => void {
  const sessions = ctx.sessions as ISessions
  const workspaces = ctx.workspaces as IWorkspaces
  const remote = ctx.remote as RemoteHome
  const lifetime = new AbortController()
  const owned = new Set<string>()
  let queued = false
  let running = false

  const reconcile = (): void => {
    if (lifetime.signal.aborted) return
    if (running) {
      queued = true
      return
    }
    running = true
    void reconcileOnce(
      sessions, workspaces, remote, workbench, config, owned, lifetime.signal,
    )
      .then(() => {
        if (lifetime.signal.aborted) return
        if (workbench.sessionIds().length === WORKBENCH_WINDOW_COUNT) {
          workbench.setBootstrapError(undefined)
        }
      })
      .catch((reason: unknown) => {
        if (lifetime.signal.aborted) return
        const message = reason instanceof Error ? reason.message : String(reason)
        console.warn('workbench bootstrap failed:', reason)
        workbench.setBootstrapError(message)
      })
      .finally(() => {
        running = false
        if (!queued) return
        queued = false
        reconcile()
      })
  }

  // The Workspace UI names the focused Workspace through the workbench; that
  // notice is what moves the panes, so it is subscribed here rather than
  // rediscovered from the lists.
  let focused = workbench.focusedWorkspaceId()
  const disposeFocus = workbench.subscribe(() => {
    const next = workbench.focusedWorkspaceId()
    if (next === focused) return
    focused = next
    reconcile()
  })
  const disposeWorkspaces = workspaces.list.subscribe(reconcile)
  const disposeSessions = sessions.list.subscribe(reconcile)
  const disposeReset = ctx.on('connection/reset', reconcile)
  reconcile()
  return () => {
    lifetime.abort()
    disposeSessions()
    disposeWorkspaces()
    disposeFocus()
    disposeReset()
  }
}

/**
 * One reconcile pass over the focused Workspace: resolve it, then bind one
 * Session per window, creating only what that Workspace is missing. Sessions
 * whose `cwd` does not equal the Workspace path are not reused, and no other
 * Workspace's windows are touched.
 * @param sessions - Session Controller.
 * @param workspaces - Workspace Controller.
 * @param remote - Host facts (`$host.home` is only used to reject home).
 * @param workbench - bind target; window Sessions are created through it.
 * @param config - resolved windows and project-root sources.
 * @param owned - Session ids this watcher created or last bound; attach may lag.
 * @param signal - plugin lifetime.
 */
export async function reconcileOnce(
  sessions: ISessions,
  workspaces: IWorkspaces,
  remote: RemoteHome,
  workbench: Workbench,
  config: ResolvedWorkbenchConfig,
  owned: Set<string>,
  signal: AbortSignal,
): Promise<void> {
  if (config.windows.length !== WORKBENCH_WINDOW_COUNT) return
  const workspace = await ensureWorkspace(sessions, workspaces, remote, workbench, config)
  if (signal.aborted || workspace === undefined) return
  const list = sessions.list.getSnapshot()
  if (list.phase !== 'ready') return
  const workspaceList = workspaces.list.getSnapshot()
  const archived = new Set(workspaceList.archivedSessionIds)
  workbench.pruneWindows(listFacts(list, workspaceList.items, archived))
  restoreOtherWorkspaces(list, workspaceList.items, archived, workbench, config, workspace.workspaceId)
  const projectRoot = workspace.path
  const bound = workbench.sessionIdsFor(workspace.workspaceId)
  const boundIds = bound.length === WORKBENCH_WINDOW_COUNT
    ? bound
    : workbench.storedWindows(workspace.workspaceId).current
  for (const id of boundIds) if (id !== '') owned.add(id)
  const past = new Set(workbench.storedWindows(workspace.workspaceId).past.flat())
  const claimed = new Set<string>()
  const next: WorkbenchWindow[] = []
  for (const [index, window] of config.windows.entries()) {
    const picked = pickWindowSession(
      list, workspace, archived, claimed, owned, past, boundIds,
      window, index, projectRoot, workbench,
    )
    if (picked !== undefined) {
      claimed.add(picked.sessionId)
      next.push(picked)
      continue
    }
    if (index !== 0 && index !== 1 && index !== 2) {
      throw new Error('workbench createSessionFor index must be 0, 1, or 2')
    }
    const created = await workbench.createSessionFor(index, workspace.workspaceId)
    if (signal.aborted) return
    owned.add(created)
    claimed.add(created)
    const row = sessions.list.getSnapshot().byId[created]
    next.push({
      sessionId: created,
      title: row?.displayTitle ?? window.agentPreset,
    })
  }
  const current = workbench.sessionIdsFor(workspace.workspaceId)
  if (current.length === WORKBENCH_WINDOW_COUNT
    && current.every((id, index) => id === next[index]?.sessionId)) return
  workbench.bind(next, workspace.workspaceId)
}

/** Member, preset, and archive facts the history prune checks against. */
function listFacts(
  list: SessionListState,
  items: readonly WorkspaceView[],
  archived: ReadonlySet<string>,
): Parameters<Workbench['pruneWindows']>[0] {
  const presets = new Map<string, string | undefined>()
  for (const [id, summary] of Object.entries(list.byId)) {
    if (summary !== undefined) presets.set(id, projectedPreset(summary))
  }
  return {
    members: new Map(items.map(item => [item.workspaceId as string, new Set<string>(item.sessionIds)])),
    presets,
    archived,
  }
}

/**
 * Bind every other listed Workspace that this page has not bound and whose
 * three stored Sessions are all still usable windows of their panes. Nothing
 * is created: a Workspace with any stale stored Session waits for its entry.
 */
function restoreOtherWorkspaces(
  list: SessionListState,
  items: readonly WorkspaceView[],
  archived: ReadonlySet<SessionId>,
  workbench: Workbench,
  config: ResolvedWorkbenchConfig,
  focused: WorkspaceId,
): void {
  for (const item of items) {
    if (item.workspaceId === focused) continue
    if (workbench.sessionIdsFor(item.workspaceId).length === WORKBENCH_WINDOW_COUNT) continue
    const stored = workbench.storedWindows(item.workspaceId).current
    const windows: WorkbenchWindow[] = []
    for (const [index, window] of config.windows.entries()) {
      const summary = list.byId[stored[index] as SessionId]
      if (
        summary === undefined
        || !usableSession(summary, item, archived, new Set(), item.path)
        || !presetFits(summary, window.agentPreset, workbench)
      ) break
      windows.push({ sessionId: summary.id, title: summary.displayTitle })
    }
    if (windows.length === WORKBENCH_WINDOW_COUNT && new Set(windows.map(w => w.sessionId)).size === WORKBENCH_WINDOW_COUNT) {
      workbench.bind(windows, item.workspaceId)
    }
  }
}

/**
 * Build the {@link resolveProjectRoot} request from live Client lists.
 * @param sessions - Session list.
 * @param workspaces - Workspace list.
 * @param remote - Host facts.
 * @param config - resolved Config plus injected `hostCwd`.
 * @returns the request object; no hidden defaults.
 */
export function projectRootRequest(
  sessions: ISessions,
  workspaces: IWorkspaces,
  remote: RemoteHome,
  config: ResolvedWorkbenchConfig,
): ProjectRootRequest {
  const list = sessions.list.getSnapshot()
  const sessionUpdatedAt: Record<string, number> = {}
  for (const [id, row] of Object.entries(list.byId)) {
    if (row !== undefined) sessionUpdatedAt[id] = row.updatedAt
  }
  return {
    workspaces: workspaces.list.getSnapshot().items,
    sessionUpdatedAt,
    configProjectRoot: config.projectRoot,
    hostCwd: config.hostCwd,
    hostHome: remote.$host.home,
  }
}

/**
 * The Workspace this pass targets: the focused one while there is one that is
 * still listed, otherwise the first-entry fallback, which resolves the project
 * root, adopts it as a Workspace, and focuses it so no later pass re-runs the
 * fallback.
 * @param sessions - Session Controller.
 * @param workspaces - Workspace Controller.
 * @param remote - Host facts (`$host.home` is only used to reject home).
 * @param workbench - focus holder, read and then set by the fallback.
 * @param config - resolved windows and project-root sources.
 * @returns the target Workspace, or undefined while the lists cannot answer.
 */
async function ensureWorkspace(
  sessions: ISessions,
  workspaces: IWorkspaces,
  remote: RemoteHome,
  workbench: Workbench,
  config: ResolvedWorkbenchConfig,
): Promise<WorkspaceView | undefined> {
  const snapshot = workspaces.list.getSnapshot()
  if (snapshot.phase !== 'ready') return undefined
  const focused = workbench.focusedWorkspaceId()
  if (focused !== undefined) {
    const listed = snapshot.items.find(item => item.workspaceId === focused)
    if (listed !== undefined) return listed
    // A stored Workspace that was deleted between pages: drop it so the
    // fallback below runs, and so the next load does not read it again.
    workbench.forgetFocusedWorkspace()
  }
  const hostHome = remote.$host.home
  let spec: ProjectRootSpec
  try {
    spec = resolveProjectRoot(projectRootRequest(sessions, workspaces, remote, config))
  } catch (error: unknown) {
    if ((hostHome === undefined || hostHome === '') && snapshot.items.length === 0) {
      return undefined
    }
    throw error
  }
  const existing = snapshot.items.find(item => sameProjectPath(item.path, spec.path))
  if (existing !== undefined) {
    workbench.focusWorkspace(existing.workspaceId)
    return existing
  }
  if (hostHome === undefined || hostHome === '') return undefined
  const created = await workspaces.create({ path: spec.path })
  workbench.focusWorkspace(created.workspaceId)
  return created
}

/**
 * The Session pane `index` shows: its bound Session while that one still fits,
 * otherwise the most recently updated matching Session that is not a past
 * window. Undefined means create one.
 */
function pickWindowSession(
  list: SessionListState,
  workspace: WorkspaceView,
  archived: ReadonlySet<SessionId>,
  claimed: ReadonlySet<string>,
  owned: ReadonlySet<string>,
  past: ReadonlySet<string>,
  boundIds: readonly string[],
  window: WorkbenchWindowConfig,
  index: number,
  projectRoot: string,
  workbench: Workbench,
): WorkbenchWindow | undefined {
  const boundId = boundIds[index]
  if (boundId !== undefined && boundId !== '' && !claimed.has(boundId)) {
    const bound = list.byId[boundId as SessionId]
    if (
      bound !== undefined
      && usableSession(bound, workspace, archived, owned, projectRoot)
      && presetFits(bound, window.agentPreset, workbench)
    ) {
      return { sessionId: bound.id, title: bound.displayTitle }
    }
  }
  return pickRecentMatching(
    list, workspace, archived, claimed, owned, past, window.agentPreset, projectRoot,
  )
}

/**
 * Whether a bound Session still runs its pane's preset. A projection that has
 * not arrived yet does not unbind it; a preset this page just selected counts
 * before the list shows it.
 */
function presetFits(summary: SessionSummary, expected: string, workbench: Workbench): boolean {
  const actual = workbench.selectedPreset(summary.id) ?? projectedPreset(summary)
  return actual === undefined || actual === expected
}

function pickRecentMatching(
  list: SessionListState,
  workspace: WorkspaceView,
  archived: ReadonlySet<SessionId>,
  claimed: ReadonlySet<string>,
  owned: ReadonlySet<string>,
  past: ReadonlySet<string>,
  agentPreset: string,
  projectRoot: string,
): WorkbenchWindow | undefined {
  let best: SessionSummary | undefined
  for (const id of list.ids) {
    if (claimed.has(id) || past.has(id)) continue
    const summary = list.byId[id]
    if (summary === undefined || !usableSession(summary, workspace, archived, owned, projectRoot)) continue
    if (projectedPreset(summary) !== agentPreset) continue
    if (best === undefined || summary.updatedAt >= best.updatedAt) best = summary
  }
  return best === undefined ? undefined : { sessionId: best.id, title: best.displayTitle }
}

function usableSession(
  summary: SessionSummary,
  workspace: WorkspaceView,
  archived: ReadonlySet<SessionId>,
  owned: ReadonlySet<string>,
  projectRoot: string,
): boolean {
  if (archived.has(summary.id)) return false
  if (summary.origin === 'subagent' || summary.parentId !== undefined) return false
  const cwd = summary.cwd
  const cwdMatches = typeof cwd === 'string' && cwd.length > 0 && sameProjectPath(cwd, projectRoot)
  const workspaceMatches = sameProjectPath(workspace.path, projectRoot)
    && workspace.sessionIds.includes(summary.id)
  if (cwdMatches || workspaceMatches) return true
  return owned.has(summary.id) && (cwd === undefined || cwd.length === 0)
}
