/**
 * Read-only reader for one project's `.dsh/hooks/` files.
 *
 * Every Host call it makes is a read: `workspaceFiles` publishes no mutation,
 * and this controller calls only `list` and `readBytes` on it. It
 * writes one thing anywhere, and that is the remembered project path in this
 * browser's own storage.
 *
 * The settings panel is root-scoped and therefore has no session, while every
 * `workspaceFiles` method is addressed by a Session identity whose header
 * supplies the workspace root. The controller picks that scope session itself
 * and reports which one it used, because the answer is only as trustworthy as
 * that choice: `list` refuses a directory outside the scope session's
 * workspace, so a project with no session of its own is read file by file
 * instead of listed.
 * @module @psychiiii/dsh-three-window-review/client/workspace-hooks-store
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  HOOK_FILE_STEMS, viewHookFile, windowViews,
  type HookFileStem, type HookFileView, type WindowHookView,
} from './hook-view.ts'

/** One catalogued session, as the project selector reads it. */
interface SessionRow {
  readonly cwd?: string
  readonly updatedAt: number
}

/**
 * The session-catalog slice this controller reads: the catalog snapshot, and
 * nothing else. Declared structurally so the controller can be driven by a
 * scripted catalog in tests without standing up a Session Controller.
 */
export interface SessionCatalog {
  readonly list: {
    getSnapshot: () => {
      readonly ids: readonly SessionId[]
      readonly byId: Readonly<Record<SessionId, SessionRow | undefined>>
    }
  }
}

/** Directory under a project root that the hook runtime opens. */
export const HOOKS_DIR_SEGMENTS = ['.dsh', 'hooks'] as const

/** Browser-storage key holding the last project the page looked at. */
export const SELECTION_STORAGE_KEY = 'dsh.personal.windowReview.selection.v1'

/** One project the selector can offer. */
export interface ProjectOption {
  /** Absolute host path of the project root. */
  readonly path: string
  /** How the page came to know about this path. */
  readonly source: 'session' | 'manual'
  /** Most recent session in this directory, when there is one. */
  readonly sessionId: SessionId | undefined
  /** When that session last changed, for ordering. */
  readonly updatedAt: number
}

/** What the hook block renders. */
export interface HooksState {
  status: 'idle' | 'loading' | 'ready' | 'no-scope' | 'error'
  error: string | null
  /**
   * A typed project path that was refused, kept verbatim so the page can quote
   * it back. Only an absolute path is accepted: `workspaceFiles` resolves a
   * relative path against the SCOPE SESSION's workspace root, so a relative
   * path would show one directory's files under another directory's name —
   * and under a name no window's hooks are ever read from.
   */
  badPath: string | null
  /** Projects the selector offers, most recently used first. */
  options: readonly ProjectOption[]
  /** The project being shown, or null before one is chosen. */
  selected: string | null
  /** `<selected>/.dsh/hooks`, once a project is chosen. */
  directory: string | null
  /** Session identity the reads were addressed to. */
  scopeSessionId: string | null
  /** The scope session's own project, which may differ from {@link selected}. */
  scopeProject: string | null
  /** Whether `.dsh/hooks` exists; false is the empty state, not an error. */
  directoryPresent: boolean
  /** Whether a directory listing was possible; false means file-by-file reads. */
  listed: boolean
  /** Names in `.dsh/hooks` that the runtime never opens. */
  strayNames: readonly string[]
  /** One view per stem, in {@link HOOK_FILE_STEMS} order. */
  files: readonly HookFileView[]
  /** Which file each window actually runs. */
  windows: readonly WindowHookView[]
}

/** The remembered selection, kept in this browser only. */
interface SelectionMemory {
  /** Last project the page showed. */
  path: string
  /** Last text typed into the manual path box, kept so a typo survives a reopen. */
  draft: string
}

const EMPTY: HooksState = {
  status: 'idle',
  error: null,
  badPath: null,
  options: [],
  selected: null,
  directory: null,
  scopeSessionId: null,
  scopeProject: null,
  directoryPresent: false,
  listed: false,
  strayNames: [],
  files: [],
  windows: [],
}

/**
 * Whether a typed project path is absolute in a host path vocabulary.
 * @param path - the text the reader typed.
 * @returns true for a POSIX root, a drive-rooted Windows path, or a UNC share.
 */
export function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** Join host path segments with the separator the base path already uses. */
export function joinHostPath(base: string, ...parts: readonly string[]): string {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  const trimmed = base.replace(/[\\/]+$/, '')
  return [trimmed.length === 0 ? base : trimmed, ...parts].join(separator)
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function failureText(failure: { code: string; message: string }): string {
  return `${failure.code}: ${failure.message}`
}

/** Decode one complete-file `readBytes` result; the Host sends bytes, the parser wants text. */
function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder().decode(data)
}

/** What the Host reports for a file that is simply not there. */
function isMissing(code: string): boolean {
  return code === 'workspace-file/not-found'
}

/** Reads one project's hook files through the read-only workspace file Remote. */
export class WorkspaceHooksController {
  /** Hook block snapshot. */
  readonly store: SnapshotStore<HooksState> = createSnapshotStore(EMPTY)

  /** Remembered selection, persisted per browser. */
  readonly memory: SnapshotStore<SelectionMemory> = createSnapshotStore(
    { path: '', draft: '' },
    { persist: { name: SELECTION_STORAGE_KEY } },
  )

  private disposed = false
  private generation = 0

  /**
   * @param ctx - client context carrying `remote.workspaceFiles`.
   * @param sessions - session catalog, the source of project candidates.
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly sessions: SessionCatalog,
  ) {}

  /**
   * Refresh the project list and read the selected project's hook files.
   * @param path - project to show; omit to use the remembered or newest one.
   * @returns settlement once the snapshot reflects the Host.
   */
  async load(path?: string): Promise<void> {
    if (this.disposed) return
    if (path !== undefined && !isAbsoluteHostPath(path)) {
      // Refused before any read: the current project stays on screen, so a
      // typo never replaces a correct view with a plausible-looking wrong one.
      this.store.update((state) => { state.badPath = path })
      return
    }
    const options = this.projectOptions(path)
    const selected = path ?? this.preferredPath(options)
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
      state.badPath = null
      state.options = options
      state.selected = selected
    })
    if (selected === null) {
      this.store.update((state) => {
        state.status = 'ready'
        state.directory = null
        state.files = []
        state.windows = []
      })
      return
    }
    this.memory.update((state) => { state.path = selected })
    await this.read(selected, options)
  }

  /** Remember the manual path box's text across reopens. */
  setDraft(draft: string): void {
    this.memory.update((state) => { state.draft = draft })
  }

  /** Stop accepting results from in-flight reads. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
  }

  /**
   * Projects the selector offers: every directory a session has run in, newest
   * first, plus the remembered path when no session names it.
   */
  private projectOptions(requested: string | undefined): ProjectOption[] {
    const list = this.sessions.list.getSnapshot()
    const byPath = new Map<string, ProjectOption>()
    for (const id of list.ids) {
      const summary = list.byId[id]
      const cwd = summary?.cwd
      if (summary === undefined || cwd === undefined || cwd.length === 0) continue
      const existing = byPath.get(cwd)
      if (existing === undefined || existing.updatedAt < summary.updatedAt) {
        byPath.set(cwd, { path: cwd, source: 'session', sessionId: id, updatedAt: summary.updatedAt })
      }
    }
    for (const extra of [requested, this.memory.getSnapshot().path]) {
      if (extra !== undefined && extra.length > 0 && !byPath.has(extra)) {
        byPath.set(extra, { path: extra, source: 'manual', sessionId: undefined, updatedAt: 0 })
      }
    }
    return [...byPath.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  }

  private preferredPath(options: readonly ProjectOption[]): string | null {
    const remembered = this.memory.getSnapshot().path
    if (remembered.length > 0) return remembered
    return options[0]?.path ?? null
  }

  /**
   * The session whose header supplies the read scope. A session in the chosen
   * project is preferred, because only then can the directory be listed.
   */
  private scopeFor(selected: string, options: readonly ProjectOption[]): ProjectOption | undefined {
    const own = options.find(option => option.path === selected && option.sessionId !== undefined)
    return own ?? options.find(option => option.sessionId !== undefined)
  }

  private async read(selected: string, options: readonly ProjectOption[]): Promise<void> {
    const generation = (this.generation += 1)
    const directory = joinHostPath(selected, ...HOOKS_DIR_SEGMENTS)
    const scope = this.scopeFor(selected, options)
    if (scope?.sessionId === undefined) {
      this.store.update((state) => {
        state.status = 'no-scope'
        state.directory = directory
        state.scopeSessionId = null
        state.scopeProject = null
        state.files = []
        state.windows = []
      })
      return
    }
    const sessionId = scope.sessionId
    const listing = await this.list(sessionId, directory)
    if (this.stale(generation)) return
    if (listing.kind === 'error') {
      this.store.update((state) => {
        state.status = 'error'
        state.error = listing.error
        state.directory = directory
        state.scopeSessionId = sessionId
        state.scopeProject = scope.path
      })
      return
    }
    const files: HookFileView[] = []
    const views = new Map<HookFileStem, HookFileView>()
    for (const stem of HOOK_FILE_STEMS) {
      const view = await this.readFile(sessionId, directory, stem)
      if (this.stale(generation)) return
      files.push(view)
      views.set(stem, view)
    }
    const present = files.some(view => view.status !== 'missing')
    this.store.update((state) => {
      state.status = 'ready'
      state.error = null
      state.selected = selected
      state.directory = directory
      state.scopeSessionId = sessionId
      state.scopeProject = scope.path
      state.directoryPresent = listing.kind === 'listed' ? listing.present : present
      state.listed = listing.kind === 'listed'
      state.strayNames = listing.kind === 'listed' ? listing.stray : []
      state.files = files
      state.windows = windowViews(views)
    })
  }

  private stale(generation: number): boolean {
    return this.disposed || generation !== this.generation
  }

  /**
   * List the hook directory when the scope session's workspace contains it.
   * A path outside that workspace is not an error here: the per-file reads
   * still work, and the page says the listing was unavailable.
   */
  private async list(
    sessionId: SessionId,
    directory: string,
  ): Promise<
    | { kind: 'listed'; present: boolean; stray: string[] }
    | { kind: 'unlisted' }
    | { kind: 'error'; error: string }
  > {
    const known = new Set(HOOK_FILE_STEMS.map(stem => `${stem}.json`))
    try {
      const response = await this.ctx.remote.workspaceFiles.list(sessionId, directory)
      if (response.ok) {
        return {
          kind: 'listed',
          present: true,
          stray: response.value.entries
            .filter(entry => entry.type === 'file' && !known.has(entry.name))
            .map(entry => entry.name),
        }
      }
      if (isMissing(response.error.code)) return { kind: 'listed', present: false, stray: [] }
      // The scope session belongs to another project: `list` is confined to
      // its workspace, while the per-file reads below are not.
      if (response.error.code === 'workspace-file/outside-workspace') return { kind: 'unlisted' }
      return { kind: 'error', error: failureText(response.error) }
    } catch (error) {
      return { kind: 'error', error: errorText(error) }
    }
  }

  private async readFile(
    sessionId: SessionId,
    directory: string,
    stem: HookFileStem,
  ): Promise<HookFileView> {
    const path = joinHostPath(directory, `${stem}.json`)
    try {
      // No range: the complete file, under the Host's full-file byte cap.
      const response = await this.ctx.remote.workspaceFiles.readBytes(sessionId, path, {})
      if (response.ok) return viewHookFile(stem, path, decodeUtf8(response.value.data))
      if (isMissing(response.error.code)) return { stem, path, status: 'missing' }
      return { stem, path, status: 'unreadable', error: failureText(response.error) }
    } catch (error) {
      return { stem, path, status: 'unreadable', error: errorText(error) }
    }
  }
}
