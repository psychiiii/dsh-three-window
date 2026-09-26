/**
 * ui-workspace contracts. Two registrations share this package:
 *
 * - WorkspaceBrowser fills the sidebar shell's `sidebar.workspaces` hole —
 *   the whole browsing region (section header, search, grouped/flat session
 *   list, workspace dialogs). It registers this package's viewing store and
 *   consumes the shell's two-fact owner share (wide / expandSidebar).
 * - WorkspacePicker fills the conversation empty-state hole (menu + error
 *   dialog shared with the browser).
 *
 * Each registration also declares one **directory-flow hole** (`single`
 * kind): the slot a composed picker package's client half fills with its
 * picking interaction — a renderless native-chooser driver or an in-app
 * browsing dialog. ui-workspace owns the trigger (the "Add workspace…"
 * entry, present only while the hole is occupied) and the adoption
 * semantics (`createWorkspace({ path })`, the retryable error dialog,
 * Choose again); the occupant owns everything between `open` and the picked path,
 * including creating a new directory to hand back. That occupant-owned
 * creation is why adding a workspace has a single route: an unoccupied hole
 * leaves the surface with no add affordance at all.
 * Two holes exist because the two menu surfaces are independent slot entries
 * and a hole has exactly one declaring entry — they carry the same owner
 * contract and the same occupant.
 */
import type { HostObservable, PropsHooks, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the owner SlotMap merges into programs that resolve the
// runtime shares below.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionSearchResultItem } from '@deepseek-ai/dsh-api-session-controller/client'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { createWorkspaceViewStore } from '../stores.ts'
import type { WindowsView } from '../tree.ts'

/** An explicit window request waiting for an archive choice (see the workbench's limit prompt). */
export interface WindowsLimitPrompt {
  readonly workspaceId: WorkspaceId
  readonly index: 0 | 1 | 2
}

/** Workbench facts the browser draws window roles and the limit dialog from. */
export interface WindowsSnapshot extends WindowsView {
  readonly limitPrompt: WindowsLimitPrompt | undefined
}

/** Result of asking where an adoption would go. */
export type AdoptionPlan =
  | { readonly ok: true; readonly index: 0 | 1 | 2 }
  | { readonly ok: false; readonly code: string }

/**
 * Owner share of the directory-flow holes: the complete conversation between
 * the trigger surface and the picking interaction. The occupant reads `open`
 * to run/render its interaction and reports exactly one outcome per open.
 */
export interface DirectoryFlowOwnerProps {
  /** True while a picking interaction is requested; flipping back to false withdraws the request. */
  open: boolean
  /** True while the owner adopts a picked path (`createWorkspace` in flight); occupants disable their commit affordances. */
  busy: boolean
  /** The operator picked a directory (absolute host path); the owner adopts it. */
  onPicked: (path: string) => void
  /** The operator dismissed the interaction; the owner just closes the flow. */
  onCancel: () => void
  /** The interaction itself failed (chooser missing, listing denied); the owner shows its error surface. */
  onError: (message: string) => void
}

/**
 * Owner share of the two Session-row schedule seats: only the row's Session
 * identity. The occupant reads that Session's own scheduled tasks. The seats
 * mirror the official `ui-workspace` row declarations from 0.1.7-rc.2, where
 * the official `ui-schedule` client fills them; on a host without that
 * occupant they stay empty.
 */
export interface SessionRowScheduleOwnerProps {
  /** Session this row shows; the occupant addresses its own data by this id. */
  readonly sessionId: SessionId
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Leading decoration of one Session row, in the 16px cell before the title.
     * Rendered only while the row shows no status dot, and never on an
     * archived or blank row.
     */
    'sidebar.session.row.leading': { kind: 'list'; scope: 'root'; owner: SessionRowScheduleOwnerProps }
    /** Section of the Session row's hover card after its relative time; mounted only while the card is open. */
    'sidebar.session.row.hover': { kind: 'list'; scope: 'root'; owner: SessionRowScheduleOwnerProps }
    /** Directory-flow hole under the conversation empty-state picker (declared by the WorkspacePicker entry). */
    'conversation.hero.workspace.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
    /** Directory-flow hole under the sidebar browsing region (declared by the WorkspaceBrowser entry). */
    'sidebar.workspaces.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
  }
}

/** The two directory-flow holes; a flow package's client half registers its one component into both. */
export type DirectoryFlowSlotName =
  | 'conversation.hero.workspace.directoryFlow'
  | 'sidebar.workspaces.directoryFlow'

/**
 * Directory-picking share both trigger surfaces consume. Occupancy rides the
 * inject face's reserved `hooks` compartment: the renderer binds the source
 * into the `useDirectoryFlow` selector hook, so an empty hole hides the
 * "Add workspace…" entry reactively and the surface withdraws an open
 * flow whose occupant unloaded mid-interaction (nobody is left to cancel).
 */
export type DirectoryPickingInjected = {
  hooks: {
    /** True while this surface's directory-flow hole is occupied. */
    directoryFlow: HostObservable<boolean>
  }
}

/** Component-side view of the picking share: the bound occupancy selector hook. */
export type DirectoryPickingHooks = PropsHooks<DirectoryPickingInjected['hooks']>

/**
 * Per-Workspace turn prompts as the list reads them. Supplied by the settings
 * package's `workspacePrompts` service; without it the list sees
 * {@link NO_WORKSPACE_PROMPTS} and offers no entry.
 */
export interface WorkspacePromptsView {
  /** False when no settings package supplies the prompts: no menu entry, no marker. */
  readonly available: boolean
  /** True once the stored prompts are known. */
  readonly ready: boolean
  /** Whether this page may write settings. */
  readonly writable: boolean
  /** Whether a write is in flight. */
  readonly saving: boolean
  /** The last refusal, or null. */
  readonly error: string | null
  /** Longest prompt, in characters. */
  readonly limit: number
  /** That Workspace's prompt, by root path, or undefined. */
  promptOf(root: string): string | undefined
  /** Rough per-turn token estimate for the editor's hint. */
  estimateTokens(text: string): number
}

/** The view without a settings package. */
export const NO_WORKSPACE_PROMPTS: WorkspacePromptsView = Object.freeze({
  available: false,
  ready: false,
  writable: false,
  saving: false,
  error: null,
  limit: 0,
  promptOf: () => undefined,
  estimateTokens: () => 0,
})

/**
 * Browser-private injected share (arrives via the register inject factory).
 * Data reads use the global framework hooks; these are the Host actions the
 * browsing region drives.
 */
export type WorkspaceBrowserInjected = {
  hooks: DirectoryPickingInjected['hooks'] & {
    /**
     * Fixed Host facts, reached through a hook rather than injected as values:
     * the renderer memoizes an entry's inject result for the registration's
     * lifetime, so facts read there would freeze at whatever the first render
     * saw. Select the field the surface needs (`info => info.home`).
     */
    hostInfo: HostObservable<RemoteHostFacts>
    /**
     * Every Workspace's current and past windows plus the waiting limit
     * prompt. Snapshot identity changes only when the workbench publishes;
     * without a workbench it is a constant inactive view.
     */
    windows: HostObservable<WindowsSnapshot>
    /** Each Workspace's turn prompt; a constant unavailable view without the settings package. */
    workspacePrompts: HostObservable<WorkspacePromptsView>
  }
  /**
   * Create a window of pane kind `index` in a Workspace through the workbench's
   * one New Window path (the same one the header New Session menu uses).
   */
  createWindow: (index: 0 | 1 | 2, workspaceId: WorkspaceId) => Promise<void>
  /** Send a past window back to its own pane. Rejects with the workbench refusal. */
  restorePast: (sessionId: SessionId) => void
  /**
   * Where adopting `sessionId` would go without a choice: a Session that has
   * spoken goes to its own preset's pane; a blank one needs a choice.
   */
  planAdoption: (sessionId: SessionId, index?: 0 | 1 | 2) => AdoptionPlan
  /** Adopt a Session into a pane of its Workspace. Rejects with the workbench refusal. */
  adoptSession: (sessionId: SessionId, index?: 0 | 1 | 2) => Promise<void>
  /** Archive one past window of the full kind, then run the waiting request. */
  resolveLimit: (sessionId: SessionId) => Promise<void>
  /** Withdraw the waiting request. */
  dismissLimit: () => void
  /** Unarchive a Session; a past window of a full kind is refused. */
  unarchiveSession: (sessionId: SessionId) => Promise<void>
  /**
   * Start a New Session in a Workspace: reuse-or-create its blank session and
   * open it; without an explicit workspace, inherit the focused Workspace, then
   * the current Session Workspace, then the recent Workspace, or clear into the
   * New Session view. In three-window mode it enters the Workspace instead.
   */
  startSession: (workspaceId?: WorkspaceId) => void
  /**
   * Enter a Workspace: in three-window mode the panes switch to that
   * Workspace's three windows and nothing is created. Returns true when the
   * workbench took it; false leaves the row's own expand/collapse as the whole
   * interaction.
   */
  focusWorkspace: (workspaceId: WorkspaceId) => boolean
  /** Open a real Session. */
  open: (sessionId: SessionId) => void
  /**
   * Search current visible conversation messages. The Host fixes the result
   * bound; `hasMore` means the query needs narrowing.
   */
  searchSessions: (
    query: string,
    signal: AbortSignal,
  ) => Promise<{ items: readonly SessionSearchResultItem[]; hasMore: boolean }>
  /** Maximum number of merged rows rendered for one search. */
  searchResultLimit: number
  /** Rename a Session (explicit user title; resolves on host acceptance). */
  renameSession: (sessionId: SessionId, title: string) => Promise<void>
  /** Fork a Session at its last completed turn and open the child. */
  forkSession: (sessionId: SessionId) => void
  /** Rename a Host Workspace (rejects on name conflict; resolves on durability). */
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<void>
  /** Store one Workspace's turn prompt by root path; blank removes it. Resolves false when refused. */
  saveWorkspacePrompt: (root: string, prompt: string) => Promise<boolean>
  /** Delete only a Host Workspace registration; directory and Session logs remain. */
  deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /**
   * Reorder a Workspace in the durable registry display order.
   * Omitted anchor appends to the end.
   */
  insertWorkspaceBefore: (workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId) => Promise<void>
  /**
   * Archive a Session into the registry-global set: hidden from grouping
   * surfaces, log and accounting slot retained. Archiving the current
   * session clears the selection into the New Session view state. A current
   * workbench window is refused.
   */
  archiveSession: (sessionId: SessionId) => Promise<void>
  /** Adopt a picked host directory as a real Workspace before targeting a Session. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
}

/** Full browser props: shell owner share + viewing store + injected actions + the locale seat. */
export type WorkspaceBrowserProps =
  PropsRuntime<'sidebar.workspaces'>
  & PropsRenderSlots<'sidebar.workspaces.directoryFlow' | 'sidebar.session.row.leading' | 'sidebar.session.row.hover'>
  & PropsStore<ReturnType<typeof createWorkspaceViewStore>>
  & Omit<WorkspaceBrowserInjected, 'hooks'>
  & PropsHooks<WorkspaceBrowserInjected['hooks']>
  & PropsLocale<'workspace'>

/**
 * Picker-private injected share. Pick semantics remain in the owner's onPick
 * callback; this callback creates only the real Host Workspace. A type alias
 * supplies the implicit index signature required by the registry.
 */
export type WorkspacePickerInjected = DirectoryPickingInjected & {
  /** Adopt a picked host directory as a real Workspace before targeting a Session. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
  /**
   * Enter a Workspace. In three-window mode picking a Workspace here switches
   * the three panes to it, which is what the chip above the composer means;
   * false hands the pick back to the owner's onPick, whose single-Session
   * behaviour moves the blank Session to that Workspace instead.
   */
  focusWorkspace: (workspaceId: WorkspaceId) => boolean
}

/**
 * Full picker props: the owner share plus the creation callback and the
 * locale seat. The two picker holes (blank-session hero / New-Session view)
 * share one owner currency, so one composed type serves both registrations.
 */
export type WorkspacePickerProps =
  PropsRuntime<'conversation.hero.workspace'>
  & PropsRenderSlots<'conversation.hero.workspace.directoryFlow'>
  & Omit<WorkspacePickerInjected, 'hooks'>
  & DirectoryPickingHooks
  & PropsLocale<'workspace'>
