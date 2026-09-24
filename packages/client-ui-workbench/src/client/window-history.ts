/**
 * Per-Workspace window history: the Sessions each pane showed before an
 * explicit replacement (the past stacks) and the three Sessions last bound
 * (the reload hint). One localStorage slot holds both, keyed by Workspace id.
 *
 * Only explicit replacement writes a past stack: creating a window, sending a
 * past Session back, and adopting another Session. `bind` writes the hint
 * alone, so a swap or a reconcile never records history. Loading and list
 * changes only remove entries (see {@link pruneWindowHistory}); they never add
 * one and never overwrite a bound pane.
 * @module @psychiiii/dsh-three-window-workbench/window-history
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** localStorage key of the fifth client slot. */
export const WORKBENCH_WINDOWS_KEY = 'dsh.workbench.windows'

/** Sessions one pane kind may hold per Workspace: the current one plus the past ones. */
export const WORKBENCH_KIND_LIMIT = 5

/** Past Sessions one pane kind may hold per Workspace. */
export const WORKBENCH_PAST_LIMIT = WORKBENCH_KIND_LIMIT - 1

/** One Workspace's stored windows. */
export interface WorkspaceWindowRecord {
  /** Last bound Session per pane, left to right; `''` where none is known. */
  readonly current: readonly [string, string, string]
  /** Past Sessions per pane index, newest first; archived ones stay listed. */
  readonly past: readonly [readonly string[], readonly string[], readonly string[]]
}

/** Stored windows of every Workspace, keyed by Workspace id. */
export type WindowHistoryState = Readonly<Record<string, WorkspaceWindowRecord>>

const EMPTY_RECORD: WorkspaceWindowRecord = { current: ['', '', ''], past: [[], [], []] }

/**
 * Create the history store; reading localStorage happens here.
 * @returns store holding every Workspace's stored windows.
 */
export function createWindowHistoryStore(): SnapshotStore<WindowHistoryState> {
  return createSnapshotStore<WindowHistoryState>({}, { persist: { name: WORKBENCH_WINDOWS_KEY } })
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * Validate a stored value: localStorage is a durable boundary another build or
 * a hand edit may have written. Anything that is not the documented shape
 * reads as absent.
 * @param raw - parsed stored value.
 * @returns a well-formed state; malformed Workspace records are dropped.
 */
export function readWindowHistory(raw: unknown): WindowHistoryState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, WorkspaceWindowRecord> = {}
  for (const [workspaceId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const record = value as { current?: unknown; past?: unknown }
    const current = Array.isArray(record.current) ? record.current : []
    const past = Array.isArray(record.past) ? record.past : []
    out[workspaceId] = {
      current: [0, 1, 2].map(index => (typeof current[index] === 'string' ? current[index] : '')) as unknown as WorkspaceWindowRecord['current'],
      past: [strings(past[0]), strings(past[1]), strings(past[2])],
    }
  }
  return out
}

/** Listed facts pruning checks stored entries against. */
export interface WindowHistoryFacts {
  /** Listed Workspaces and their member Session ids. */
  readonly members: ReadonlyMap<string, ReadonlySet<string>>
  /** Listed Session ids with their projected preset, when known. */
  readonly presets: ReadonlyMap<string, string | undefined>
  /** Archived Session ids. */
  readonly archived: ReadonlySet<string>
  /** Config preset per pane index. */
  readonly windowPresets: readonly string[]
  /** Live bound Session ids per Workspace. */
  readonly bound: ReadonlyMap<string, readonly string[]>
}

/**
 * Drop what no longer holds: Workspaces no longer listed, hinted Sessions no
 * longer listed, past Sessions no longer listed or no longer members of that
 * Workspace, past Sessions whose known
 * preset is not their pane's, past Sessions that are a current window, and
 * unarchived past Sessions beyond {@link WORKBENCH_PAST_LIMIT} (the oldest go).
 * Archived past Sessions stay so unarchiving can return them.
 * @param state - stored state.
 * @param facts - current lists.
 * @returns `state` itself when nothing changed, otherwise the pruned copy.
 */
export function pruneWindowHistory(state: WindowHistoryState, facts: WindowHistoryFacts): WindowHistoryState {
  let changed = false
  const out: Record<string, WorkspaceWindowRecord> = {}
  for (const [workspaceId, record] of Object.entries(state)) {
    const members = facts.members.get(workspaceId)
    if (members === undefined) { changed = true; continue }
    const listed = (id: string): boolean => facts.presets.has(id) && members.has(id)
    // A just-created Session can be listed before its Workspace account names
    // it, so the hint is checked against the list alone; bootstrap validates
    // membership before it binds a hinted Session.
    const current = record.current.map(id => (id !== '' && facts.presets.has(id) ? id : '')) as unknown as WorkspaceWindowRecord['current']
    const bound = new Set([...(facts.bound.get(workspaceId) ?? []), ...current.filter(id => id !== '')])
    const seen = new Set<string>()
    const past = record.past.map((entries, index) => {
      let unarchived = 0
      return entries.filter((id) => {
        if (!listed(id) || bound.has(id) || seen.has(id)) return false
        const preset = facts.presets.get(id)
        if (preset !== undefined && preset !== facts.windowPresets[index]) return false
        if (!facts.archived.has(id)) {
          if (unarchived >= WORKBENCH_PAST_LIMIT) return false
          unarchived += 1
        }
        seen.add(id)
        return true
      })
    }) as unknown as WorkspaceWindowRecord['past']
    const same = current.every((id, index) => id === record.current[index])
      && past.every((entries, index) => entries.length === record.past[index]?.length)
    if (!same) changed = true
    out[workspaceId] = same ? record : { current, past }
  }
  return changed ? out : state
}

/**
 * Record `sessionId` as the newest past Session of one pane.
 * @param state - stored state.
 * @param workspaceId - owning Workspace.
 * @param index - pane index the Session left.
 * @param sessionId - the replaced Session.
 * @returns the new state.
 */
export function pushPast(state: WindowHistoryState, workspaceId: string, index: number, sessionId: string): WindowHistoryState {
  const record = state[workspaceId] ?? EMPTY_RECORD
  const past = record.past.map((entries, i) => {
    const rest = entries.filter(id => id !== sessionId)
    return i === index ? [sessionId, ...rest] : rest
  }) as unknown as WorkspaceWindowRecord['past']
  return { ...state, [workspaceId]: { current: record.current, past } }
}

/**
 * Remove `sessionId` from every past stack of one Workspace.
 * @param state - stored state.
 * @param workspaceId - owning Workspace.
 * @param sessionId - Session leaving the past stacks.
 * @returns the new state, or `state` when it was not there.
 */
export function removePast(state: WindowHistoryState, workspaceId: string, sessionId: string): WindowHistoryState {
  const record = state[workspaceId]
  if (record === undefined || !record.past.some(entries => entries.includes(sessionId))) return state
  const past = record.past.map(entries => entries.filter(id => id !== sessionId)) as unknown as WorkspaceWindowRecord['past']
  return { ...state, [workspaceId]: { current: record.current, past } }
}

/**
 * Store the three Sessions a Workspace was last bound to.
 * @param state - stored state.
 * @param workspaceId - owning Workspace.
 * @param ids - bound Session ids, left to right.
 * @returns the new state, or `state` when unchanged.
 */
export function setCurrent(state: WindowHistoryState, workspaceId: string, ids: readonly string[]): WindowHistoryState {
  const record = state[workspaceId] ?? EMPTY_RECORD
  const current = [0, 1, 2].map(index => ids[index] ?? '') as unknown as WorkspaceWindowRecord['current']
  if (current.every((id, index) => id === record.current[index]) && state[workspaceId] !== undefined) return state
  return { ...state, [workspaceId]: { current, past: record.past } }
}

/**
 * One Workspace's record.
 * @param state - stored state.
 * @param workspaceId - Workspace to read.
 * @returns its record, or an empty one.
 */
export function recordOf(state: WindowHistoryState, workspaceId: string): WorkspaceWindowRecord {
  return state[workspaceId] ?? EMPTY_RECORD
}
