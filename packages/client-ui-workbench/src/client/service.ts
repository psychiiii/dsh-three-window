/**
 * Three side-by-side Conversation windows, one set per Workspace. `ctx.workbench`
 * exposes operations and the snapshot the panes and the sidebar draw from.
 *
 * Pane bindings are keyed by Workspace: the panes show the focused Workspace's
 * three Sessions, and every other Workspace's binding stays in the table until
 * it is focused again. Nothing here picks the focused Workspace — the Workspace
 * UI names it through {@link Workbench.focusWorkspace}, bootstrap names the
 * first one when the page has no restorable focus, and the focus store resumes
 * the Workspace the previous page entered.
 *
 * Each pane kind (chat, construct, review) of each Workspace holds at most
 * {@link WORKBENCH_KIND_LIMIT} Sessions: the current one plus past ones. Only an
 * explicit replacement — {@link Workbench.createWindow},
 * {@link Workbench.restorePast}, {@link Workbench.adoptSession} — moves the
 * replaced Session onto its pane's past stack, and each of them refuses a
 * replacement that would exceed the limit.
 * @module @psychiiii/dsh-three-window-workbench/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { notifySubscribers, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ISessions, SessionFace, SessionReference, SessionReferenceSource, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { IWorkspaces, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  resolveClientWorkbenchConfig, WORKBENCH_WINDOW_COUNT,
  type ResolvedWorkbenchConfig,
} from '../config.ts'
import { resolveProjectRoot, sameProjectPath } from '../project-root.ts'
import { createFocusStore } from './focus-store.ts'
import type {} from './session-retention.ts'
import {
  createWindowHistoryStore, pruneWindowHistory, pushPast, readWindowHistory, recordOf, removePast,
  setCurrent, WORKBENCH_KIND_LIMIT, WORKBENCH_PAST_LIMIT,
  type WindowHistoryState,
} from './window-history.ts'
import type { WorkbenchWindow } from './windows.ts'

/** Pane index, left to right: chat, construct, review. */
export type WorkbenchPaneIndex = 0 | 1 | 2

/** One pane in left-to-right order. `sessionId` is absent before bind. */
export interface WorkbenchPaneSnapshot {
  readonly sessionId: string | undefined
  readonly title: string
  /** Live retain handle; absent while unbound, missing from the list, or not yet retained. */
  readonly reference: SessionReference | undefined
  /** Whether `reference.ready` has settled for this pane. */
  readonly ready: boolean
}

/**
 * One Workspace's windows as the sidebar draws them. `current` is the live
 * binding (empty before that Workspace is bound on this page); `past` is the
 * stored past stack per pane, newest first, archived Sessions included.
 */
export interface WorkbenchLayout {
  readonly current: readonly string[]
  readonly past: readonly (readonly string[])[]
  /** Session last focused by a pane click inside this Workspace. */
  readonly focusedSessionId: string | undefined
}

/** What an explicit window request waits on when its pane kind is full. */
export type WorkbenchLimitAction =
  | { readonly kind: 'create' }
  | { readonly kind: 'adopt'; readonly sessionId: string }

/**
 * A request refused because its pane kind already holds
 * {@link WORKBENCH_KIND_LIMIT} Sessions. The UI offers the kind's unarchived
 * past Sessions; archiving one through {@link Workbench.resolveLimitPrompt}
 * runs `action`.
 */
export interface WorkbenchLimitPrompt {
  readonly workspaceId: WorkspaceId
  readonly index: WorkbenchPaneIndex
  readonly action: WorkbenchLimitAction
}

/** Result of an explicit window request. */
export type WorkbenchWindowOutcome =
  /** The pane shows the requested Session; the replaced one is now a past window. */
  | 'replaced'
  /** The Workspace had no bound windows: it was entered, and entering binds its three. */
  | 'entered'
  /** The pane kind is full: {@link WorkbenchSnapshot.limitPrompt} asks for an archive. */
  | 'needs-archive'

/** Thrown when a replacement would exceed {@link WORKBENCH_KIND_LIMIT} for one pane kind. */
export class WorkbenchKindFullError extends Error {
  override readonly name = 'WorkbenchKindFullError'

  /**
   * @param workspaceId - Workspace whose pane kind is full.
   * @param index - the full pane kind.
   */
  constructor(readonly workspaceId: WorkspaceId, readonly index: WorkbenchPaneIndex) {
    super(`workbench window kind ${String(index)} of workspace ${workspaceId} already holds ${String(WORKBENCH_KIND_LIMIT)} sessions; archive a past one first`)
  }
}

/** Why the workbench refused a window operation. */
export type WorkbenchRefusalCode =
  /** Archiving a Session a pane currently shows would leave that pane empty. */
  | 'current-window'
  /** A review window is created only by the three-window create path. */
  | 'review-adoption'
  /** A Session that has spoken keeps its preset, and that preset is not one of the three windows'. */
  | 'foreign-preset'
  /** A Session that has spoken can only go to the pane kind of its own preset. */
  | 'kind-mismatch'
  /** The Session is not a listed, unarchived, top-level member of a listed Workspace. */
  | 'not-adoptable'
  /** The Session already is a current or past window. */
  | 'already-window'
  /** The Session is not a past window, or no longer fits its pane. */
  | 'not-past'

/** A refused window operation; `code` names the refusing rule. */
export class WorkbenchRefusal extends Error {
  override readonly name = 'WorkbenchRefusal'

  /**
   * @param code - the refusing rule.
   * @param message - diagnostic naming the Session.
   */
  constructor(readonly code: WorkbenchRefusalCode, message: string) {
    super(message)
  }
}

/** Where one Session sits in the three-window layout. */
export interface WorkbenchWindowRole {
  readonly workspaceId: WorkspaceId
  readonly index: WorkbenchPaneIndex
  readonly kind: 'current' | 'past'
}

/** Viewing state for the three Conversation panes and every Workspace's windows. */
export interface WorkbenchSnapshot {
  readonly panes: readonly [WorkbenchPaneSnapshot, WorkbenchPaneSnapshot, WorkbenchPaneSnapshot]
  /**
   * Session last focused by a pane click inside the focused Workspace; absent
   * before the first focus there. Each Workspace keeps its own.
   */
  readonly focusedSessionId: string | undefined
  /** Bootstrap failure shown on unbound panes; absent after a successful bind. */
  readonly bootstrapError: string | undefined
  /** Workspace the panes show; absent before the first focus. */
  readonly focusedWorkspaceId: WorkspaceId | undefined
  /** Every Workspace bound on this page or holding stored windows. */
  readonly layouts: ReadonlyMap<WorkspaceId, WorkbenchLayout>
  /** An explicit request waiting for an archive choice; absent otherwise. */
  readonly limitPrompt: WorkbenchLimitPrompt | undefined
}

/** Inject face for the workbench occupant. */
export interface WorkbenchInjected {
  readonly hooks: {
    readonly workbench: HostObservable<WorkbenchSnapshot>
  }
  /**
   * Focus the pane showing `sessionId`.
   * @param sessionId - bound Conversation Session.
   */
  readonly focus: (sessionId: string) => void
  /**
   * Bind exactly three ordinary Sessions as one Workspace's permanent row split.
   * @param windows - left, center, and right Conversation Sessions.
   * @param workspaceId - Workspace these three windows belong to.
   */
  readonly bind: (windows: readonly WorkbenchWindow[], workspaceId: WorkspaceId) => void
  /**
   * Swap two windows by left-to-right index.
   * @param fromIndex - source pane index in `0..2`.
   * @param toIndex - destination pane index in `0..2`.
   */
  readonly swap: (fromIndex: number, toIndex: number) => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Three-window Conversation workbench operations. */
    workbench: Workbench
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** One workbench pane's independent Session retain. */
    workbenchPane: unknown
  }
}

/** One Workspace's three panes and the pane last focused inside them. */
interface WorkspaceBinding {
  readonly windows: readonly WorkbenchWindow[]
  readonly focusedSessionId: string | undefined
}

/** Client Remote face for preset selection. */
interface PresetRemote {
  readonly agentPresets?: {
    select(sessionId: SessionId, agentPreset: string): Promise<RemoteResult<string>>
  }
}

const UNBOUND_BINDING: WorkspaceBinding = { windows: [], focusedSessionId: undefined }

const UNBOUND_PANE: WorkbenchPaneSnapshot = {
  sessionId: undefined, title: '', reference: undefined, ready: false,
}
const UNBOUND_SNAPSHOT: WorkbenchSnapshot = {
  panes: [UNBOUND_PANE, UNBOUND_PANE, UNBOUND_PANE],
  focusedSessionId: undefined,
  bootstrapError: undefined,
  focusedWorkspaceId: undefined,
  layouts: new Map(),
  limitPrompt: undefined,
}

const PANE_SOURCE: SessionReferenceSource = 'workbenchPane'

/** Thrown when waiters are still queued and the inject fiber never provided `remote.session`. */
const MISSING_REMOTE_SESSION = 'workbench createSessionFor requires remote.session'

function isPaneIndex(index: number): index is WorkbenchPaneIndex {
  return index === 0 || index === 1 || index === 2
}

/** Projected preset of a listed Session, when the projection has arrived. */
export function projectedPreset(summary: Pick<SessionSummary, 'projectionValues'>): string | undefined {
  const projected = summary.projectionValues?.['agentPreset']
  return typeof projected === 'string' && projected.length > 0 ? projected : undefined
}

/**
 * Host-agnostic three-window surface. Pane identity is not a routing key.
 */
export class Workbench extends Service {
  private readonly bindings = new Map<WorkspaceId, WorkspaceBinding>()
  private readonly focusStore: SnapshotStore<string>
  private readonly windowStore: SnapshotStore<WindowHistoryState>
  private focused: WorkspaceId | undefined
  private snapshot: WorkbenchSnapshot = UNBOUND_SNAPSHOT
  private limitPrompt: WorkbenchLimitPrompt | undefined
  /** Presets this page selected for adopted Sessions, until the list projection agrees. */
  private readonly selectedPresets = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private readonly refs = new Map<string, SessionReference>()
  /** Sessions {@link pinModel} already handled on this page. */
  private readonly pinnedModels = new Set<string>()
  private readonly ready = new Map<string, boolean>()
  private readonly retaining = new Set<string>()
  private bootstrapError: string | undefined
  private readonly applied: ResolvedWorkbenchConfig | undefined
  private attached: Context | undefined
  private readonly attachWaiters: Array<{
    resolve: (ready: Context) => void
    reject: (error: Error) => void
  }> = []

  /**
   * @param ctx - Client root context.
   * @param applied - resolved windows from Client `apply`; live page global otherwise.
   * @param focus - focus store; `apply` creates the live page's one. Tests pass
   *   their own, so no case reads a value another case left in storage.
   * @param windows - window-history store; same ownership as `focus`.
   */
  constructor(
    ctx: Context,
    applied?: ResolvedWorkbenchConfig,
    focus?: SnapshotStore<string>,
    windows?: SnapshotStore<WindowHistoryState>,
  ) {
    super(ctx, 'workbench')
    this.applied = applied
    this.focusStore = focus ?? createFocusStore()
    this.windowStore = windows ?? createWindowHistoryStore()
    const stored = this.windowStore.getSnapshot()
    const normalized = readWindowHistory(stored)
    if (JSON.stringify(normalized) !== JSON.stringify(stored)) this.windowStore.set(normalized)
    this.focused = this.persistedFocus()
    ctx.effect(() => {
      const sessions = ctx.sessions as ISessions
      const disposeList = sessions.list.subscribe(() => {
        this.syncReferences()
        this.publish()
      })
      return () => {
        disposeList()
        this.releaseAll()
        this.rejectAttachWaiters()
      }
    }, 'ui-workbench: retain pane Sessions')
  }

  /**
   * Current pane bindings and every Workspace's windows.
   * @returns the published snapshot; identity changes only on publish.
   */
  getSnapshot(): WorkbenchSnapshot {
    return this.snapshot
  }

  /**
   * Subscribe to snapshot changes.
   * @param listener - notified after bind, swap, pane focus, Workspace focus,
   *   retain, history, limit prompt, or list change.
   * @returns disposer.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Record or clear a bootstrap failure for unbound panes to display.
   * @param message - thrown diagnostic, or undefined after a successful reconcile.
   */
  setBootstrapError(message: string | undefined): void {
    if (this.bootstrapError === message) return
    this.bootstrapError = message
    this.publish()
  }

  /**
   * Bind exactly three ordinary Sessions as one Workspace's permanent row
   * split. Binding a Workspace that is not focused only fills the table: the
   * panes keep showing the focused Workspace. The three ids are stored as that
   * Workspace's reload hint; no past stack changes here.
   * @param windows - left, center, and right Conversation Sessions.
   * @param workspaceId - Workspace these three windows belong to.
   * @throws when `windows` is not length 3 or repeats a Session id.
   */
  bind(windows: readonly WorkbenchWindow[], workspaceId: WorkspaceId): void {
    assertBindable(windows)
    const previous = this.bindings.get(workspaceId) ?? UNBOUND_BINDING
    if (
      previous.windows.length === WORKBENCH_WINDOW_COUNT
      && previous.windows.every((window, index) =>
        window.sessionId === windows[index]?.sessionId && window.title === windows[index]?.title)
    ) return
    const focusedSessionId = windows.some(window => window.sessionId === previous.focusedSessionId)
      ? previous.focusedSessionId
      : undefined
    this.bindings.set(workspaceId, { windows, focusedSessionId })
    this.writeHistory(setCurrent(this.history(), workspaceId, windows.map(window => window.sessionId)))
    if (workspaceId === this.focused) this.syncReferences()
    this.publish()
  }

  /**
   * Make `workspaceId` the Workspace the three panes show, and remember it as
   * the one a reload resumes. The panes switch to that Workspace's binding, or
   * go unbound until bootstrap creates it; no Session is created here.
   * @param workspaceId - Workspace the UI navigated to.
   * @returns true when three-window mode owns Workspace entry, so the caller
   *   must not also run its single-Session navigation. False leaves the focus
   *   recorded and the caller in charge.
   */
  focusWorkspace(workspaceId: WorkspaceId): boolean {
    if (this.focused !== workspaceId) {
      this.focused = workspaceId
      this.syncReferences()
      this.persistFocus(workspaceId)
      this.publish()
    }
    return this.ownsWorkspaceEntry()
  }

  /**
   * Workspace the three panes currently show.
   * @returns the focused Workspace, or undefined before the first focus.
   */
  focusedWorkspaceId(): WorkspaceId | undefined {
    return this.focused
  }

  /**
   * Drop the focus, and the stored one with it. Bootstrap calls this when the
   * focused Workspace is no longer listed — a deleted Workspace must not keep
   * the panes off every listed one, on this page or on the next load.
   */
  forgetFocusedWorkspace(): void {
    if (this.focused === undefined) return
    this.focused = undefined
    this.persistFocus('' as WorkspaceId)
    this.syncReferences()
    this.publish()
  }

  /**
   * Focus the pane showing `sessionId` inside the focused Workspace.
   * @param sessionId - bound Conversation Session.
   * @throws when the focused Workspace has no bound windows or the Session is
   *   not one of its three windows.
   */
  focus(sessionId: string): void {
    const workspaceId = this.focused
    const binding = this.focusedBinding()
    if (workspaceId === undefined || binding.windows.length !== WORKBENCH_WINDOW_COUNT) {
      throw new Error('workbench has no bound windows')
    }
    if (!binding.windows.some(window => window.sessionId === sessionId)) {
      throw new Error(`workbench has no window for session ${JSON.stringify(sessionId)}`)
    }
    this.bindings.set(workspaceId, { windows: binding.windows, focusedSessionId: sessionId })
    this.publish()
  }

  /**
   * Swap two windows of the focused Workspace by left-to-right index. A swap
   * is not a replacement: no past stack changes.
   * @param fromIndex - source pane index in `0..2`.
   * @param toIndex - destination pane index in `0..2`.
   */
  swap(fromIndex: number, toIndex: number): void {
    const workspaceId = this.focused
    const windows = this.focusedBinding().windows
    if (workspaceId === undefined || windows.length !== WORKBENCH_WINDOW_COUNT) {
      throw new Error('workbench has no bound windows')
    }
    if (fromIndex === toIndex) return
    const next = [...windows]
    const from = next[fromIndex]
    const to = next[toIndex]
    if (from === undefined || to === undefined) {
      throw new Error('workbench swap indexes must be 0, 1, or 2')
    }
    next[fromIndex] = to
    next[toIndex] = from
    this.bind(next, workspaceId)
  }

  /**
   * Hold the inject fiber that owns Host session create. Callers of
   * {@link createSessionFor} wait until this runs. Disposing the returned
   * effect rejects waiters and clears the fiber so {@link windowed} is false.
   * @param ready - `ctx.inject` fiber that includes `remote.session`.
   * @returns disposer that detaches this fiber.
   */
  attach(ready: Context): () => void {
    this.attached = ready
    const waiters = this.attachWaiters.splice(0)
    for (const waiter of waiters) waiter.resolve(ready)
    this.publish()
    return () => {
      if (this.attached !== ready) return
      this.attached = undefined
      this.rejectAttachWaiters()
      this.publish()
    }
  }

  /**
   * Whether New Session is a three-window picker.
   * @returns true when Config has three rows, {@link attach} has provided Host
   *   session create, and the focused Workspace has three bound panes. False
   *   while a newly focused Workspace's windows are still being created.
   */
  windowed(): boolean {
    return this.ownsWorkspaceEntry()
      && this.attached !== undefined
      && this.sessionIds().length === WORKBENCH_WINDOW_COUNT
  }

  /**
   * Whether entering a Workspace means showing its three panes rather than
   * opening one main Session. It answers from Config alone — not from
   * {@link attach} and not from the current bindings — so the answer cannot
   * flip while a page boots or while a newly focused Workspace's windows are
   * still being created, which is what {@link windowed} reports instead.
   * @returns true when Config names three windows.
   */
  ownsWorkspaceEntry(): boolean {
    return this.windowsConfig().windows.length === WORKBENCH_WINDOW_COUNT
  }

  /**
   * Create a Host Session for one Config window and apply its permission. The
   * Session is not bound: bootstrap binds it with the Workspace's other two
   * windows. Explicit replacement goes through {@link createWindow}.
   * Waits for {@link attach} instead of throwing; a never-attached dispose
   * rejects with `remote.session` in the message.
   * @param index - left-to-right pane index.
   * @param workspaceId - Host workspace for the new Session.
   * @returns the new Session id.
   */
  async createSessionFor(index: WorkbenchPaneIndex, workspaceId: WorkspaceId): Promise<SessionId> {
    const ready = await this.awaitAttached()
    const session = (ready as { remote?: SessionCreateRemoteHost }).remote?.session
    if (session === undefined) throw new Error(MISSING_REMOTE_SESSION)
    const spec = this.windowsConfig().windows[index]
    if (spec === undefined) {
      throw new Error('workbench createSessionFor requires three Config windows')
    }
    const result = await (ready as Context & { remote: SessionCreateRemoteHost }).remote.session.create({
      workspaceId,
      agentPreset: spec.agentPreset,
    })
    if (!result.ok) throw new Error(result.error.message)
    const sessions = this.ctx.sessions as ISessions
    await sessions.refresh()
    const created = result.value.sessionId
    await this.applyCreatedPermission(sessions, created, spec, index)
    return created
  }

  /**
   * The one New Window path for every control: create a Session for pane
   * `index` of a Workspace and bind it there; the Session it replaces becomes
   * that pane's newest past window. A Workspace with no bound windows is
   * entered instead, because entering binds its three. A full pane kind
   * creates nothing and raises {@link WorkbenchSnapshot.limitPrompt}.
   * @param index - left-to-right pane index in `0..2`.
   * @param workspaceId - target Workspace; absent means the focused one.
   * @returns what happened.
   */
  async createWindow(index: number, workspaceId?: WorkspaceId): Promise<WorkbenchWindowOutcome> {
    const resolved = this.windowsConfig()
    if (resolved.windows.length !== WORKBENCH_WINDOW_COUNT) {
      throw new Error('workbench createWindow requires three Config windows')
    }
    if (!isPaneIndex(index)) {
      throw new Error('workbench createWindow index must be 0, 1, or 2')
    }
    const sessions = this.ctx.sessions as ISessions
    const workspaces = this.ctx.get('workspaces') as IWorkspaces | undefined
    if (workspaces === undefined) throw new Error('workbench createWindow requires workspaces')
    const target = workspaceId ?? this.focused ?? this.workspaceForProjectRoot(sessions, workspaces)
    if (target === undefined) throw new Error('workbench createWindow: no workspace')
    if (target !== this.focused) {
      this.focusWorkspace(target)
      if (this.sessionIdsFor(target).length !== WORKBENCH_WINDOW_COUNT) return 'entered'
    }
    if (this.sessionIds().length !== WORKBENCH_WINDOW_COUNT) {
      throw new Error('workbench createWindow requires three bound windows')
    }
    if (this.isKindFull(target, index)) {
      this.raiseLimit({ workspaceId: target, index, action: { kind: 'create' } })
      return 'needs-archive'
    }
    const created = await this.createSessionFor(index, target)
    const row = sessions.list.getSnapshot().byId[created]
    this.replacePane(target, index, created, row?.displayTitle ?? resolved.windows[index]?.agentPreset ?? '')
    return 'replaced'
  }

  /**
   * Send a past window back to the pane it came from; the Session there
   * becomes the newest past window. The kind's count does not change.
   * @param sessionId - a past window.
   * @throws {@link WorkbenchRefusal} `not-past` when the Session is not an
   *   unarchived listed past window whose preset still fits its pane.
   */
  restorePast(sessionId: string): void {
    const role = this.windowRole(sessionId)
    if (role?.kind !== 'past') {
      throw new WorkbenchRefusal('not-past', `workbench: session ${sessionId} is not a past window`)
    }
    const summary = this.summaryOf(sessionId)
    if (summary === undefined || this.archivedIds().has(sessionId) || !this.presetFits(summary, role.index)) {
      throw new WorkbenchRefusal('not-past', `workbench: past window ${sessionId} is archived, missing, or no longer runs its pane's preset`)
    }
    if (this.sessionIdsFor(role.workspaceId).length !== WORKBENCH_WINDOW_COUNT) {
      throw new WorkbenchRefusal('not-past', `workbench: workspace ${role.workspaceId} has no bound windows yet`)
    }
    this.focusWorkspace(role.workspaceId)
    this.replacePane(role.workspaceId, role.index, sessionId, summary.displayTitle)
  }

  /**
   * Put a Session that is not a window into one pane of its own Workspace.
   * A Session that has spoken keeps its preset, so it goes to the pane of that
   * preset and `index` may only name that pane. A blank Session is switched to
   * the preset of pane `index` first, and may not become the review pane: a
   * review window is created only by {@link createWindow} or bootstrap. Either
   * way the pane's Config permission is submitted, as on a created window. The
   * replaced Session becomes a past window; a full pane kind raises
   * {@link WorkbenchSnapshot.limitPrompt} instead.
   * @param sessionId - Session to adopt.
   * @param index - target pane; required for a blank Session.
   * @returns what happened.
   * @throws {@link WorkbenchRefusal} for every rule above.
   */
  async adoptSession(sessionId: string, index?: number): Promise<WorkbenchWindowOutcome> {
    const plan = this.planAdoption(sessionId, index)
    if (this.sessionIdsFor(plan.workspaceId).length === WORKBENCH_WINDOW_COUNT && this.isKindFull(plan.workspaceId, plan.index)) {
      this.raiseLimit({ workspaceId: plan.workspaceId, index: plan.index, action: { kind: 'adopt', sessionId } })
      return 'needs-archive'
    }
    const summary = this.summaryOf(sessionId) as SessionSummary
    const preset = this.windowsConfig().windows[plan.index]?.agentPreset as string
    if (projectedPreset(summary) !== preset) {
      const remote = (this.attached as (Context & { remote?: PresetRemote }) | undefined)?.remote
        ?? (this.ctx.get('remote') as PresetRemote | undefined)
      const agentPresets = remote?.agentPresets
      if (agentPresets === undefined) throw new Error('workbench adoptSession requires remote.agentPresets')
      const result = await agentPresets.select(sessionId as SessionId, preset)
      if (!result.ok) {
        throw new WorkbenchRefusal('kind-mismatch', `workbench: session ${sessionId} cannot switch to ${preset}: ${result.error.message}`)
      }
      this.selectedPresets.set(sessionId, preset)
      await (this.ctx.sessions as ISessions).refresh()
    }
    // The pane's permission, as on a window this workbench creates: an adopted
    // window must match a created one of its kind.
    const spec = this.windowsConfig().windows[plan.index] as { agentPreset: string; permission: string }
    await this.applyCreatedPermission(this.ctx.sessions as ISessions, sessionId as SessionId, spec, plan.index)
    if (this.sessionIdsFor(plan.workspaceId).length !== WORKBENCH_WINDOW_COUNT) {
      const record = recordOf(this.history(), plan.workspaceId)
      const current = [...record.current]
      current[plan.index] = sessionId
      this.writeHistory(setCurrent(this.history(), plan.workspaceId, current))
      if (this.focused === plan.workspaceId) this.publish()
      else this.focusWorkspace(plan.workspaceId)
      return 'entered'
    }
    this.focusWorkspace(plan.workspaceId)
    this.replacePane(plan.workspaceId, plan.index, sessionId, summary.displayTitle)
    return 'replaced'
  }

  /**
   * Which pane an adoption of `sessionId` would use, or why it is refused.
   * The sidebar asks this before offering a choice.
   * @param sessionId - candidate Session.
   * @param index - requested pane; absent for a Session that has spoken.
   * @returns the owning Workspace and target pane.
   * @throws {@link WorkbenchRefusal} naming the refusing rule.
   */
  planAdoption(sessionId: string, index?: number): { workspaceId: WorkspaceId; index: WorkbenchPaneIndex } {
    const summary = this.summaryOf(sessionId)
    const workspaces = this.ctx.get('workspaces') as IWorkspaces | undefined
    const owner = workspaces?.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId as SessionId))
    if (
      summary === undefined || owner === undefined || this.archivedIds().has(sessionId)
      || summary.origin === 'subagent' || summary.parentId !== undefined
    ) {
      throw new WorkbenchRefusal('not-adoptable', `workbench: session ${sessionId} is not an unarchived top-level session of a listed workspace`)
    }
    if (this.windowRole(sessionId) !== undefined) {
      throw new WorkbenchRefusal('already-window', `workbench: session ${sessionId} already is a window`)
    }
    const presets = this.windowsConfig().windows.map(window => window.agentPreset)
    if (summary.blank) {
      if (index === undefined || !isPaneIndex(index)) {
        throw new Error('workbench adoptSession: a blank session needs a pane index 0 or 1')
      }
      if (index === 2) {
        throw new WorkbenchRefusal('review-adoption', `workbench: a review window is created only by the three-window create path; session ${sessionId} cannot become one`)
      }
      return { workspaceId: owner.workspaceId, index }
    }
    const own = projectedPreset(summary)
    const ownIndex = own === undefined ? -1 : presets.indexOf(own)
    if (!isPaneIndex(ownIndex)) {
      throw new WorkbenchRefusal('foreign-preset', `workbench: session ${sessionId} runs preset ${own ?? '(unknown)'}, which is not a window preset; archive it instead`)
    }
    if (index !== undefined && index !== ownIndex) {
      throw new WorkbenchRefusal('kind-mismatch', `workbench: session ${sessionId} has spoken as ${own ?? ''} and can only become pane ${String(ownIndex)}`)
    }
    return { workspaceId: owner.workspaceId, index: ownIndex }
  }

  /**
   * Archive one unarchived past window of the waiting request's pane kind,
   * then run that request again.
   * @param archiveSessionId - the past window to archive.
   * @returns the outcome of the re-run request.
   * @throws {@link WorkbenchRefusal} `not-past` when the Session is not an
   *   unarchived past window of that kind.
   */
  async resolveLimitPrompt(archiveSessionId: string): Promise<WorkbenchWindowOutcome> {
    const prompt = this.limitPrompt
    if (prompt === undefined) throw new Error('workbench has no waiting window request')
    const role = this.windowRole(archiveSessionId)
    if (
      role?.kind !== 'past' || role.workspaceId !== prompt.workspaceId || role.index !== prompt.index
      || this.archivedIds().has(archiveSessionId)
    ) {
      throw new WorkbenchRefusal('not-past', `workbench: session ${archiveSessionId} is not an unarchived past window of the full kind`)
    }
    const workspaces = this.ctx.get('workspaces') as IWorkspaces
    await workspaces.archiveSession(archiveSessionId as SessionId)
    this.limitPrompt = undefined
    this.publish()
    if (prompt.action.kind === 'create') return this.createWindow(prompt.index, prompt.workspaceId)
    return this.adoptSession(prompt.action.sessionId, prompt.index)
  }

  /** Withdraw the waiting request without archiving anything. */
  dismissLimitPrompt(): void {
    if (this.limitPrompt === undefined) return
    this.limitPrompt = undefined
    this.publish()
  }

  /**
   * Refuse to archive a Session a pane currently shows: that pane would go
   * empty. Past windows and other Sessions pass.
   * @param sessionId - Session about to be archived.
   * @throws {@link WorkbenchRefusal} `current-window`.
   */
  assertArchivable(sessionId: string): void {
    if (this.windowRole(sessionId)?.kind === 'current') {
      throw new WorkbenchRefusal('current-window', `workbench: session ${sessionId} is a current window; replace it before archiving`)
    }
  }

  /**
   * Refuse to unarchive a past window whose pane kind is already full.
   * @param sessionId - Session about to be unarchived.
   * @throws {@link WorkbenchKindFullError} when it would make the kind exceed the limit.
   */
  assertUnarchivable(sessionId: string): void {
    const role = this.windowRole(sessionId)
    if (role?.kind === 'past' && this.archivedIds().has(sessionId) && this.isKindFull(role.workspaceId, role.index)) {
      throw new WorkbenchKindFullError(role.workspaceId, role.index)
    }
  }

  /**
   * Where a Session sits: a current window of a bound Workspace, or a past
   * window in a stored past stack.
   * @param sessionId - Session to locate.
   * @returns its role, or undefined for any other Session.
   */
  windowRole(sessionId: string): WorkbenchWindowRole | undefined {
    for (const [workspaceId, binding] of this.bindings) {
      const index = binding.windows.findIndex(window => window.sessionId === sessionId)
      if (isPaneIndex(index)) return { workspaceId, index, kind: 'current' }
    }
    for (const [workspaceId, record] of Object.entries(this.history())) {
      const index = record.past.findIndex(entries => entries.includes(sessionId))
      if (isPaneIndex(index)) return { workspaceId: workspaceId as WorkspaceId, index, kind: 'past' }
    }
    return undefined
  }

  /**
   * Sessions pane kind `index` of a Workspace holds against the limit: the
   * current one plus unarchived listed past ones.
   * @param workspaceId - Workspace to count.
   * @param index - pane kind.
   * @returns the count, at most {@link WORKBENCH_KIND_LIMIT} unless the store was written by hand.
   */
  kindCount(workspaceId: WorkspaceId, index: WorkbenchPaneIndex): number {
    const archived = this.archivedIds()
    const past = recordOf(this.history(), workspaceId).past[index] ?? []
    const listed = past.filter(id => !archived.has(id) && this.summaryOf(id) !== undefined).length
    return listed + (this.sessionIdsFor(workspaceId)[index] === undefined ? 0 : 1)
  }

  /**
   * Remove stored history that no longer matches the lists. Bootstrap calls
   * this on every reconcile pass once both lists are ready.
   * @param facts - member, preset, and archive facts of the current lists.
   */
  pruneWindows(facts: {
    readonly members: ReadonlyMap<string, ReadonlySet<string>>
    readonly presets: ReadonlyMap<string, string | undefined>
    readonly archived: ReadonlySet<string>
  }): void {
    const bound = new Map<string, readonly string[]>()
    for (const [workspaceId, binding] of this.bindings) bound.set(workspaceId, binding.windows.map(window => window.sessionId))
    const next = pruneWindowHistory(this.history(), {
      ...facts,
      windowPresets: this.windowsConfig().windows.map(window => window.agentPreset),
      bound,
    })
    if (next !== this.history()) {
      this.writeHistory(next)
      this.publish()
    }
  }

  /**
   * Stored windows of one Workspace: the reload hint and the past stacks.
   * @param workspaceId - Workspace to read.
   * @returns its stored current hint (`''` where unknown) and past stacks.
   */
  storedWindows(workspaceId: WorkspaceId): { current: readonly string[]; past: readonly (readonly string[])[] } {
    return recordOf(this.history(), workspaceId)
  }

  /**
   * Preset this page selected for `sessionId` while the list projection may
   * still show the old one.
   * @param sessionId - adopted Session.
   * @returns the selected preset, or undefined.
   */
  selectedPreset(sessionId: string): string | undefined {
    return this.selectedPresets.get(sessionId)
  }

  /**
   * Bound Session ids of the focused Workspace, in left-to-right order. This
   * is the row the panes show, never every Workspace's windows.
   * @returns three Session ids once the focused Workspace is bound, otherwise
   *   empty — including when no Workspace is focused yet.
   */
  sessionIds(): readonly string[] {
    return this.focusedBinding().windows.map(window => window.sessionId)
  }

  /**
   * Bound Session ids of one Workspace, focused or not.
   * @param workspaceId - Workspace to read.
   * @returns its three Session ids in left-to-right order, otherwise empty.
   */
  sessionIdsFor(workspaceId: WorkspaceId): readonly string[] {
    return (this.bindings.get(workspaceId) ?? UNBOUND_BINDING).windows.map(window => window.sessionId)
  }

  /**
   * The single writer of past stacks: bind `sessionId` to pane `index` and
   * push the Session it replaces onto that pane's past stack.
   * @throws {@link WorkbenchKindFullError} when the push would exceed the limit.
   */
  private replacePane(workspaceId: WorkspaceId, index: WorkbenchPaneIndex, sessionId: string, title: string): void {
    const binding = this.bindings.get(workspaceId) ?? UNBOUND_BINDING
    if (binding.windows.length !== WORKBENCH_WINDOW_COUNT) {
      throw new Error(`workbench: workspace ${workspaceId} has no bound windows`)
    }
    const replaced = binding.windows[index]?.sessionId
    if (replaced === sessionId) return
    let history = removePast(this.history(), workspaceId, sessionId)
    if (replaced !== undefined) {
      const past = recordOf(history, workspaceId).past[index] ?? []
      const archived = this.archivedIds()
      if (past.filter(id => !archived.has(id)).length >= WORKBENCH_PAST_LIMIT) {
        throw new WorkbenchKindFullError(workspaceId, index)
      }
      history = pushPast(history, workspaceId, index, replaced)
    }
    this.writeHistory(history)
    const next: WorkbenchWindow[] = [0, 1, 2].map(paneIndex => (
      paneIndex === index ? { sessionId, title } : binding.windows[paneIndex] as WorkbenchWindow
    ))
    this.bind(next, workspaceId)
    if (workspaceId === this.focused) this.focus(sessionId)
    else this.publish()
  }

  private isKindFull(workspaceId: WorkspaceId, index: WorkbenchPaneIndex): boolean {
    return this.kindCount(workspaceId, index) >= WORKBENCH_KIND_LIMIT
  }

  private raiseLimit(prompt: WorkbenchLimitPrompt): void {
    this.limitPrompt = prompt
    this.publish()
  }

  private presetFits(summary: SessionSummary, index: WorkbenchPaneIndex): boolean {
    const expected = this.windowsConfig().windows[index]?.agentPreset
    const actual = this.selectedPresets.get(summary.id) ?? projectedPreset(summary)
    return actual === undefined || actual === expected
  }

  private summaryOf(sessionId: string): SessionSummary | undefined {
    const sessions = this.ctx.get('sessions') as ISessions | undefined
    return sessions?.list.getSnapshot().byId[sessionId as SessionId]
  }

  private archivedIds(): ReadonlySet<string> {
    const workspaces = this.ctx.get('workspaces') as IWorkspaces | undefined
    return new Set(workspaces?.list.getSnapshot().archivedSessionIds ?? [])
  }

  private history(): WindowHistoryState {
    return this.windowStore.getSnapshot()
  }

  private writeHistory(next: WindowHistoryState): void {
    if (next !== this.windowStore.getSnapshot()) this.windowStore.set(next)
  }

  /**
   * Submit `/permission <preset>` on a Session this workbench just created or
   * adopted. Bootstrap reuse never calls this.
   * @param sessions - Client catalog used to locate a live Session face.
   * @param sessionId - the Session returned by Host create.
   * @param spec - window row that named the official preset.
   * @param index - left-to-right pane index, included in failure text.
   */
  private async applyCreatedPermission(
    sessions: ISessions,
    sessionId: SessionId,
    spec: { agentPreset: string; permission: string },
    index: WorkbenchPaneIndex,
  ): Promise<void> {
    const live = sessions.binding(sessionId)?.session
    if (live !== undefined) {
      await this.submitPermission(live, spec, index)
      return
    }
    const reference = this.refs.get(sessionId) ?? this.ctx.sessionRetention.retain(sessionId, { source: PANE_SOURCE })
    const owned = this.refs.get(sessionId) !== reference
    try {
      const binding = await reference.ready
      await this.submitPermission(binding.session, spec, index)
    } finally {
      if (owned) reference.release()
    }
  }

  private async submitPermission(
    session: SessionFace,
    spec: { agentPreset: string; permission: string },
    index: WorkbenchPaneIndex,
  ): Promise<void> {
    const line = `/permission ${spec.permission}`
    const result = await session.command(line)
    const where = `workbench createSessionFor window ${String(index)} (${spec.agentPreset}) ${line}`
    if (!result.ok) {
      throw new Error(`${where} failed: ${result.error.message}`)
    }
    if (!result.value.matched) {
      throw new Error(`${where}: host has no /permission command`)
    }
  }

  private windowsConfig(): ResolvedWorkbenchConfig {
    if (this.applied !== undefined && this.applied.windows.length === WORKBENCH_WINDOW_COUNT) {
      return this.applied
    }
    return resolveClientWorkbenchConfig()
  }

  /** Focus a previous page left behind. Empty and non-string stored values both read as none. */
  private persistedFocus(): WorkspaceId | undefined {
    const stored = this.focusStore.getSnapshot()
    return typeof stored !== 'string' || stored.length === 0 ? undefined : stored as WorkspaceId
  }

  private persistFocus(workspaceId: WorkspaceId): void {
    this.focusStore.set(workspaceId)
  }

  private focusedBinding(): WorkspaceBinding {
    if (this.focused === undefined) return UNBOUND_BINDING
    return this.bindings.get(this.focused) ?? UNBOUND_BINDING
  }

  /**
   * Fallback Workspace for {@link createWindow} before anything has been
   * focused: the resolved project root's Workspace.
   * @param sessions - Client catalog supplying Session recency.
   * @param workspaces - Client catalog supplying listed Workspaces.
   * @returns the matching Workspace id, or undefined when none is listed.
   */
  private workspaceForProjectRoot(sessions: ISessions, workspaces: IWorkspaces): WorkspaceId | undefined {
    const resolved = this.windowsConfig()
    const remote = this.ctx.get('remote') as { $host?: { home?: string } } | undefined
    const list = sessions.list.getSnapshot()
    const sessionUpdatedAt: Record<string, number> = {}
    for (const [id, row] of Object.entries(list.byId)) {
      if (row !== undefined) sessionUpdatedAt[id] = row.updatedAt
    }
    const spec = resolveProjectRoot({
      workspaces: workspaces.list.getSnapshot().items,
      sessionUpdatedAt,
      configProjectRoot: resolved.projectRoot,
      hostCwd: resolved.hostCwd,
      hostHome: remote?.$host?.home,
    })
    return workspaces.list.getSnapshot().items
      .find(item => sameProjectPath(item.path, spec.path))
      ?.workspaceId
  }

  private awaitAttached(): Promise<Context> {
    if (this.attached !== undefined) return Promise.resolve(this.attached)
    return new Promise((resolve, reject) => {
      this.attachWaiters.push({ resolve, reject })
    })
  }

  private rejectAttachWaiters(): void {
    const error = new Error(MISSING_REMOTE_SESSION)
    const waiters = this.attachWaiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
  }

  /**
   * Retain the focused Workspace's three Sessions and release everything else.
   * Another Workspace's binding survives in the table without a live retain;
   * focusing it again re-retains its Sessions.
   */
  private syncReferences(): void {
    const sessions = this.ctx.sessions as ISessions | undefined
    if (sessions === undefined) return
    const windows = this.focusedBinding().windows
    const listed = sessions.list.getSnapshot().byId
    const wanted = new Set(windows.map(window => window.sessionId))
    for (const [id, reference] of this.refs) {
      if (wanted.has(id) && listed[id as SessionId] !== undefined) continue
      reference.release()
      this.refs.delete(id)
      this.ready.delete(id)
    }
    for (const window of windows) {
      const id = window.sessionId
      if (listed[id as SessionId] === undefined) continue
      if (this.refs.has(id) || this.retaining.has(id)) continue
      this.retaining.add(id)
      let reference: SessionReference
      try {
        reference = this.ctx.sessionRetention.retain(id as SessionId, { source: PANE_SOURCE })
      } finally {
        this.retaining.delete(id)
      }
      this.refs.set(id, reference)
      this.ready.set(id, false)
      void reference.ready.then(
        (binding) => {
          if (this.refs.get(id) !== reference) return
          this.ready.set(id, true)
          this.publish()
          void this.pinModel(id, binding.session)
        },
        () => {
          if (this.refs.get(id) !== reference) return
          this.ready.set(id, false)
          this.publish()
        },
      )
    }
  }

  /**
   * Give a bound Session its own model selection when it has none yet.
   *
   * A Session with no selection and no logged request runs on the live global
   * default model, and a pick in any pane both selects for that pane's Session
   * and rewrites that default. A fresh pane would therefore follow every pick
   * made in the other two. Selecting the current default for it once — through
   * the same public `selectModel` the picker calls — makes each pane's model
   * its own from the start; later picks stay per pane. A Session that already
   * has a selection or a logged request is left alone.
   * @param sessionId - the bound Session.
   * @param session - its live face, from the pane's retained reference.
   */
  private async pinModel(sessionId: string, session: SessionFace): Promise<void> {
    if (this.pinnedModels.has(sessionId)) return
    this.pinnedModels.add(sessionId)
    try {
      const selection = await firstSnapshot(session.projections.faceOf('modelSelection')) as
        { next: ModelPick | null } | undefined
      if (selection === undefined || selection.next !== null) return
      const ready = await this.awaitAttached()
      const remote = (ready as { remote?: { session?: ModelRemote } }).remote?.session
      if (remote?.modelCatalog === undefined || remote.selectModel === undefined) return
      const catalog = await remote.modelCatalog()
      if (!catalog.ok) throw new Error(`modelCatalog: ${catalog.error.message}`)
      const pick = catalog.value.default
      const result = await remote.selectModel({
        sessionId: sessionId as SessionId,
        provider: pick.provider,
        model: pick.model,
        ...pick.reasoningEffort === undefined ? {} : { reasoningEffort: pick.reasoningEffort },
      })
      if (!result.ok) throw new Error(`selectModel: ${result.error.message}`)
    } catch (error) {
      // The pane still works on the shared default; it only loses independence.
      console.warn(`workbench: could not give session ${sessionId} its own model:`, error)
    }
  }

  private releaseAll(): void {
    for (const reference of this.refs.values()) reference.release()
    this.refs.clear()
    this.ready.clear()
  }

  private publish(): void {
    const binding = this.focusedBinding()
    const history = this.history()
    const layouts = new Map<WorkspaceId, WorkbenchLayout>()
    for (const workspaceId of new Set([...this.bindings.keys(), ...Object.keys(history) as WorkspaceId[]])) {
      const bound = this.bindings.get(workspaceId) ?? UNBOUND_BINDING
      layouts.set(workspaceId, {
        current: bound.windows.map(window => window.sessionId),
        past: recordOf(history, workspaceId).past,
        focusedSessionId: bound.focusedSessionId,
      })
    }
    this.snapshot = {
      panes: [
        this.paneOf(binding.windows[0]),
        this.paneOf(binding.windows[1]),
        this.paneOf(binding.windows[2]),
      ],
      focusedSessionId: binding.focusedSessionId,
      bootstrapError: this.bootstrapError,
      focusedWorkspaceId: this.focused,
      layouts,
      limitPrompt: this.limitPrompt,
    }
    notifySubscribers(this.listeners, '[ui-workbench] panes')
  }

  private paneOf(window: WorkbenchWindow | undefined): WorkbenchPaneSnapshot {
    if (window === undefined) return UNBOUND_PANE
    return {
      sessionId: window.sessionId,
      title: window.title,
      reference: this.refs.get(window.sessionId),
      ready: this.ready.get(window.sessionId) === true,
    }
  }
}

interface SessionCreateRemote {
  create(request: {
    workspaceId?: WorkspaceId
    cwd?: string
    sessionId?: SessionId
    agentPreset?: string
  }): Promise<RemoteResult<{ sessionId: SessionId; agentPreset?: string }>>
}

/** One provider/model/effort choice, as the model catalog and `selectModel` spell it. */
interface ModelPick {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** The public Session Remote calls {@link Workbench.pinModel} uses; the picker uses the same two. */
interface ModelRemote {
  modelCatalog?(): Promise<RemoteResult<{ default: ModelPick }>>
  selectModel?(request: {
    sessionId: SessionId
    provider: string
    model: string
    reasoningEffort?: string
  }): Promise<RemoteResult<unknown>>
}

/**
 * The first defined value of an observable snapshot, or undefined when none
 * arrives within `timeoutMs` (a projection is seeded by the Session's first page).
 */
function firstSnapshot(
  face: { getSnapshot(): unknown; subscribe(listener: () => void): () => void },
  timeoutMs = 15_000,
): Promise<unknown> {
  const now = face.getSnapshot()
  if (now !== undefined) return Promise.resolve(now)
  return new Promise((resolve) => {
    const stop = face.subscribe(() => {
      const value = face.getSnapshot()
      if (value === undefined) return
      clearTimeout(timer)
      stop()
      resolve(value)
    })
    const timer = setTimeout(() => { stop(); resolve(undefined) }, timeoutMs)
  })
}

interface SessionCreateRemoteHost {
  session: SessionCreateRemote
}

function assertBindable(windows: readonly WorkbenchWindow[]): void {
  if (windows.length !== WORKBENCH_WINDOW_COUNT) {
    throw new Error(`workbench binds exactly ${String(WORKBENCH_WINDOW_COUNT)} windows`)
  }
  const seen = new Set<string>()
  for (const window of windows) {
    if (window.sessionId.length === 0) throw new Error('workbench window sessionId must be non-empty')
    if (seen.has(window.sessionId)) {
      throw new Error(`workbench window sessionId ${JSON.stringify(window.sessionId)} is bound more than once`)
    }
    seen.add(window.sessionId)
  }
}
