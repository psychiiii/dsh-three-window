/**
 * Derives the workspace browser tree from caller-projected Workspace and
 * Session order. Unassigned Sessions trail under Ungrouped; only the selected
 * blank Session remains visible.
 */
import {
  type SessionListState, type SessionSearchResultItem, type SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  SessionStatusSnapshot,
} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import {
  indexSubagentDescendants, type SubagentDescendantSummary,
} from './subagent-lineage.ts'

/** Group key for Sessions outside every Workspace. */
export const UNGROUPED_KEY = ''

/**
 * Resolve the Workspace browser group that owns one Session.
 * @param workspaces - authoritative Workspace membership.
 * @param sessionId - Session whose browser group is required.
 * @returns owning Workspace id, or {@link UNGROUPED_KEY} when no Workspace accounts for it.
 */
export function owningGroupKey(
  workspaces: readonly WorkspaceView[],
  sessionId: SessionId,
): string {
  return (workspaces.find(workspace => workspace.sessionIds.includes(sessionId))
    ?.workspaceId as string | undefined) ?? UNGROUPED_KEY
}

/** Pending interaction kinds with dedicated Workspace-row presentation. */
export type SessionPendingInteractionStatus = 'approval' | 'plan-review' | 'question'
type SessionStatuses = SessionStatusSnapshot

function mainSessionId(list: SessionListState): SessionId | undefined {
  return Object.values(list.byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/** One top-level session row in a group or the flat list. */
export interface SessionNode {
  id: SessionId
  /** Stored display title; the renderer substitutes the localized New Session label for blank rows. */
  title: string
  /** The provisional blank session (renderer shows the localized New Session title). */
  blank: boolean
  /** Workbench pane this session occupies in its own Workspace, left-to-right; absent when it is not a current window. */
  occupancy?: 0 | 1 | 2
  /** Pane kind this session was a window of before an explicit replacement; absent unless it is a past window. */
  past?: 0 | 1 | 2
  /** The pane last focused in the focused Workspace shows this session. */
  active?: boolean
  /** Archived past window, listed only under its Workspace's archived fold. */
  archived?: boolean
  /** A Session-scoped UI consumer is awaiting this user. */
  pendingInteraction?: SessionPendingInteractionStatus
  running: boolean
  /** Running descendants connected through uninterrupted subagent-origin lineage. */
  runningSubagentCount: number
  /** Finished running while not selected and not yet opened (the green "done" reminder dot). */
  completed: boolean
  /** The current list projection contains at least one active Schedule record. */
  hasActiveSchedule: boolean
  updatedAt: number
}

/** Session order selected by the Workspace browser. */
export type SessionOrderBy = 'manual' | 'updated'

/** One workspace group section: header row facts + visible top-level session rows. */
export interface GroupNode {
  /** Group key: the workspace id or {@link UNGROUPED_KEY}. */
  key: string
  /** Backing Workspace id; absent only for the ungrouped bucket. */
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  /** Workspace creation time (epoch ms); absent only for the ungrouped bucket. */
  createdAt: number | undefined
  label: string
  /** Total visible sessions in the group. */
  sessionCount: number
  expanded: boolean
  /** The group contains the selected session (active folder tint; supplied here so the renderer never scans). */
  containsCurrent: boolean
  /** Visible session rows (empty while the group is folded). */
  sessions: readonly SessionNode[]
  /**
   * Three-window structure of the same rows, present while three-window mode
   * owns Workspace entry: the current windows in pane order, the past windows
   * per pane kind, every other visible session, and the archived past windows.
   * Empty lists while the group is folded.
   */
  windows?: GroupWindows
}

/** One Workspace group's rows split by window role. */
export interface GroupWindows {
  current: readonly SessionNode[]
  past: readonly [readonly SessionNode[], readonly SessionNode[], readonly SessionNode[]]
  others: readonly SessionNode[]
  archived: readonly SessionNode[]
}

/** Stored and bound windows of one Workspace, as the workbench publishes them. */
export interface WindowsLayout {
  readonly current: readonly string[]
  readonly past: readonly (readonly string[])[]
  readonly focusedSessionId: string | undefined
}

/** The workbench facts the browser derives window roles from. */
export interface WindowsView {
  /** Three-window mode owns Workspace entry. */
  readonly active: boolean
  readonly focusedWorkspaceId: string | undefined
  readonly layouts: ReadonlyMap<string, WindowsLayout>
}

/** No workbench: every row keeps the official presentation. */
export const NO_WINDOWS: WindowsView = { active: false, focusedWorkspaceId: undefined, layouts: new Map() }

/** Where one Session sits in the three-window layout. */
export interface WindowRole {
  readonly workspaceId: string
  readonly index: 0 | 1 | 2
  readonly kind: 'current' | 'past'
  readonly active: boolean
}

/**
 * Index every current and past window by Session id.
 * @param windows - workbench facts.
 * @returns role per Session; a Session appears under its own Workspace only.
 */
export function windowRoles(windows: WindowsView): ReadonlyMap<string, WindowRole> {
  const roles = new Map<string, WindowRole>()
  for (const [workspaceId, layout] of windows.layouts) {
    layout.current.forEach((id, index) => {
      if (index > 2 || id === '') return
      roles.set(id, {
        workspaceId, index: index as 0 | 1 | 2, kind: 'current',
        active: workspaceId === windows.focusedWorkspaceId && id === layout.focusedSessionId,
      })
    })
  }
  for (const [workspaceId, layout] of windows.layouts) {
    layout.past.forEach((ids, index) => {
      if (index > 2) return
      for (const id of ids) {
        if (!roles.has(id)) roles.set(id, { workspaceId, index: index as 0 | 1 | 2, kind: 'past', active: false })
      }
    })
  }
  return roles
}

/** One flat search row combining list metadata with an optional content match. */
export interface SearchResultNode {
  id: SessionId
  title: string
  workspace: string
  /** A Session-scoped UI consumer is awaiting this user. */
  pendingInteraction?: SessionPendingInteractionStatus
  running: boolean
  /** Running descendants connected through uninterrupted subagent-origin lineage. */
  runningSubagentCount: number
  /** Finished running while not selected and not yet opened (the green "done" reminder dot). */
  completed: boolean
  /** The current list projection contains at least one active Schedule record. */
  hasActiveSchedule: boolean
  snippet?: string
}

/** Bounded merged search projection plus the refine-query hint bit. */
export interface SearchResultSet {
  items: readonly SearchResultNode[]
  hasMore: boolean
}

/** Viewing state consumed by the derivation. */
export interface TreeView {
  expandedGroups: readonly string[]
  /** Browser-local order for Sessions without a backing Workspace account. */
  ungroupedOrder?: readonly string[]
  /** Workbench windows of every Workspace; absent or inactive keeps the official rows. */
  windows?: WindowsView
}

interface Group {
  key: string
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  createdAt: number | undefined
  label: string
  sessions: SessionSummary[]
}

/**
 * Directory display label: basename of the path (both separators accepted).
 * Ungrouped-bucket fallback for surfaces without a workspace title.
 * @param cwd - directory path, or undefined for the ungrouped bucket.
 * @returns basename, the raw cwd when it has no basename, or an empty ungrouped marker.
 */
export function workspaceLabel(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return ''
  const base = workspaceTitleOf(cwd)
  return base !== '' ? base : cwd
}

/**
 * Project known account members by current Session recency.
 * @param sessionIds - authoritative account membership.
 * @param summaries - current Session summaries; members without a summary are omitted until it arrives.
 * @returns known members newest first, with Session identity as the deterministic tie-break.
 */
export function orderByRecency(
  sessionIds: readonly SessionId[],
  summaries: SessionListState['byId'],
): SessionId[] {
  return sessionIds.flatMap((id) => {
    const summary = summaries[id]
    return summary === undefined ? [] : [{ id, updatedAt: summary.updatedAt }]
  })
    .sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
      return a.id < b.id ? -1 : 1
    })
    .map(member => member.id)
}

/**
 * Reconcile a browser-local manual order with current account membership.
 * @param memberIds - authoritative account membership.
 * @param savedOrder - previously saved browser-local order.
 * @param summaries - current Session summaries used to append newly known members by recency.
 * @returns retained saved slots followed by newly known members; departed members and unknown new members are omitted.
 */
export function reconcileManualOrder(
  memberIds: readonly SessionId[],
  savedOrder: readonly string[] | undefined,
  summaries: SessionListState['byId'],
): SessionId[] {
  const members = new Map(memberIds.map(id => [id as string, id]))
  const included = new Set<string>()
  const ordered: SessionId[] = []
  for (const key of savedOrder ?? []) {
    const id = members.get(key)
    if (id === undefined || included.has(key)) continue
    ordered.push(id)
    included.add(key)
  }
  for (const id of orderByRecency(memberIds, summaries)) {
    if (included.has(id)) continue
    ordered.push(id)
    included.add(id)
  }
  return ordered
}

/**
 * Keep the selected provisional New Session ahead of either base order.
 * @param order - recency or reconciled manual order.
 * @param currentBlank - selected blank Session in this account, when present.
 * @returns a copy with the selected blank first and no duplicate slot.
 */
export function pinCurrentBlank(
  order: readonly SessionId[],
  currentBlank: SessionId | undefined,
): SessionId[] {
  if (currentBlank === undefined) return [...order]
  return [currentBlank, ...order.filter(id => id !== currentBlank)]
}

/** Sessions a window role keeps visible even while blank: every current and unarchived past window. */
function windowIds(roles: ReadonlyMap<string, WindowRole>, archived: ReadonlySet<SessionId>): Set<SessionId> {
  const ids = new Set<SessionId>()
  for (const id of roles.keys()) if (!archived.has(id as SessionId)) ids.add(id as SessionId)
  return ids
}

/**
 * Ordinary sessions are visible; among blank sessions, only the current one
 * or a workbench occupant is visible. Subagent children use their parent
 * header catalog; archived sessions are visible nowhere, while their
 * accounting slots remain so unarchiving restores position.
 */
function sessionVisible(
  session: SessionSummary,
  current: SessionId | undefined,
  archived: ReadonlySet<SessionId>,
  occupied: ReadonlySet<SessionId>,
): boolean {
  return session.origin !== 'subagent'
    && !archived.has(session.id)
    && (!session.blank || session.id === current || occupied.has(session.id))
}

/**
 * A blank session is the selected Workspace's provisional New Session row;
 * its canonical title never enters search (blank rows are query-excluded)
 * and the renderer localizes its display label.
 */
function sessionTitle(session: SessionSummary): string {
  return session.blank ? '' : session.displayTitle
}

/**
 * Whether the list projection carries at least one active Schedule record.
 * Hosts up to 0.1.7-rc.1 register the `schedule` projection; later hosts drop
 * it and fill the `sidebar.session.row.*` seats instead, so the key is read
 * as host data that may be absent rather than through the projection map type.
 */
function hasActiveSchedule(session: SessionSummary): boolean {
  const values: Readonly<Record<string, unknown>> | undefined = session.projectionValues
  const schedule = values?.['schedule']
  return Array.isArray(schedule) && schedule.length > 0
}

/** Build one group without projecting session lineage into presentation. */
function buildGroup(
  key: string,
  workspaceId: WorkspaceId | undefined,
  cwd: string | undefined,
  createdAt: number | undefined,
  label: string,
  members: readonly SessionSummary[],
): Group {
  return { key, workspaceId, cwd, createdAt, label, sessions: [...members] }
}

/** Apply a stored Ungrouped order and append newly loose Sessions by recency. */
function orderedUngrouped(
  members: readonly SessionSummary[],
  stored: readonly string[] | undefined,
  summaries: SessionListState['byId'],
): SessionSummary[] {
  const byId = new Map(members.map(session => [session.id as string, session]))
  const ids = stored === undefined
    ? orderByRecency(members.map(session => session.id), summaries)
    : reconcileManualOrder(members.map(session => session.id), stored, summaries)
  return ids.flatMap((id) => {
    const session = byId.get(id)
    /* v8 ignore next -- ids are projected exclusively from the members used to build byId. */
    return session === undefined ? [] : [session]
  })
}

/**
 * Group Sessions by Workspace: one group per caller-ordered entity, with
 * members resolved from caller-ordered sessionIds. Sessions outside every
 * Workspace trail in the browser-local Ungrouped order, which falls back to
 * recency before that order is initialized.
 */
function groupByWorkspace(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archived: ReadonlySet<SessionId>,
  occupied: ReadonlySet<SessionId>,
  ungroupedOrder: readonly string[] | undefined,
): Group[] {
  const current = mainSessionId(list)
  const groups: Group[] = []
  const accounted = new Set<SessionId>()
  for (const workspace of workspaces) {
    const members: SessionSummary[] = []
    for (const id of workspace.sessionIds) {
      const summary = list.byId[id]
      if (summary === undefined) continue // account may lead the list pull; the row appears when the summary lands
      accounted.add(id)
      if (!sessionVisible(summary, current, archived, occupied)) continue
      members.push(summary)
    }
    groups.push(buildGroup(
      workspace.workspaceId, workspace.workspaceId, workspace.path,
      Date.parse(workspace.createdAt), workspace.title, members,
    ))
  }
  const stray = list.ids
    .map(id => list.byId[id])
    .filter((s): s is SessionSummary =>
      s !== undefined && !accounted.has(s.id) && sessionVisible(s, current, archived, occupied))
  if (stray.length > 0) {
    groups.push(buildGroup(
      UNGROUPED_KEY,
      undefined,
      undefined,
      undefined,
      '',
      orderedUngrouped(stray, ungroupedOrder, list.byId),
    ))
  }
  return groups
}

/** Keep navigation presentation independent from domain-owned interaction objects. */
function visiblePendingKind(kind: string | undefined): SessionPendingInteractionStatus | undefined {
  switch (kind) {
    case 'approval':
    case 'plan-review':
    case 'question':
      return kind
    default:
      return undefined
  }
}

function sessionNode(
  s: SessionSummary,
  descendants: ReadonlyMap<SessionId, SubagentDescendantSummary>,
  statuses: SessionStatuses,
  roles: ReadonlyMap<string, WindowRole>,
  archived?: boolean,
): SessionNode {
  const status = statuses.get(s.id)
  const pendingInteraction = visiblePendingKind(status?.pendingInteraction?.kind)
  const role = roles.get(s.id)
  return {
    id: s.id,
    title: sessionTitle(s),
    blank: s.blank,
    running: status?.running ?? s.running,
    runningSubagentCount: descendants.get(s.id)?.runningCount ?? 0,
    completed: status?.completionUnread === true,
    hasActiveSchedule: hasActiveSchedule(s),
    updatedAt: s.updatedAt,
    ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
    ...(role?.kind === 'current' ? { occupancy: role.index } : {}),
    ...(role?.kind === 'past' ? { past: role.index } : {}),
    ...(role?.active === true ? { active: true } : {}),
    ...(archived === true ? { archived: true } : {}),
  }
}

/** Split one expanded group's rows by window role. */
function groupWindows(
  group: Group,
  list: SessionListState,
  layout: WindowsLayout | undefined,
  archived: ReadonlySet<SessionId>,
  descendants: ReadonlyMap<SessionId, SubagentDescendantSummary>,
  statuses: SessionStatuses,
  roles: ReadonlyMap<string, WindowRole>,
): GroupWindows {
  const node = (id: string, isArchived = false): SessionNode[] => {
    const summary = list.byId[id as SessionId]
    return summary === undefined ? [] : [sessionNode(summary, descendants, statuses, roles, isArchived)]
  }
  const own = (id: string): boolean => roles.get(id)?.workspaceId === group.workspaceId
  const current = (layout?.current ?? []).filter(own).flatMap(id => node(id))
  const pastOf = (index: number): SessionNode[] => (layout?.past[index] ?? [])
    .filter(id => !archived.has(id as SessionId) && own(id)).flatMap(id => node(id))
  const inWindows = new Set([...(layout?.current ?? []), ...(layout?.past.flat() ?? [])])
  return {
    current,
    past: [pastOf(0), pastOf(1), pastOf(2)],
    others: group.sessions.filter(summary => !inWindows.has(summary.id))
      .map(summary => sessionNode(summary, descendants, statuses, roles)),
    archived: (layout?.past.flat() ?? []).filter(id => archived.has(id as SessionId)).flatMap(id => node(id, true)),
  }
}

/**
 * Derive the workspace browser groups with every session as a top-level row.
 *
 * Every group shows; sessions populate under expanded groups in the selected
 * local order. Blank sessions are excluded except for the selected
 * provisional New Session row; archived sessions are excluded everywhere.
 * Content search lives outside this derivation
 * (see {@link deriveSearchResults}).
 * @param list - sessions list snapshot (`mainView` retention feeds containsCurrent).
 * @param workspaces - real Workspaces in Host group order with caller-projected Session order.
 * @param archivedSessionIds - registry-global archive set.
 * @param statuses - unified UI status by Session.
 * @param view - local expansion arrays.
 * @returns group sections in render order.
 */
export function deriveGroups(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[],
  statuses: SessionStatuses,
  view: TreeView,
): GroupNode[] {
  const archived = new Set(archivedSessionIds)
  const windows = view.windows ?? NO_WINDOWS
  const roles = windowRoles(windows)
  const occupied = windowIds(roles, archived)
  const expandedGroups = new Set(view.expandedGroups)
  const descendants = indexSubagentDescendants(list.byId)
  const current = mainSessionId(list)
  const currentGroup = current === undefined
    ? undefined
    : owningGroupKey(workspaces, current)
  const groups: GroupNode[] = []
  for (const g of groupByWorkspace(list, workspaces, archived, occupied, view.ungroupedOrder)) {
    const expanded = expandedGroups.has(g.key)
    const structured = windows.active
      ? { windows: expanded
        ? groupWindows(g, list, g.workspaceId === undefined ? undefined : windows.layouts.get(g.workspaceId), archived, descendants, statuses, roles)
        : { current: [], past: [[], [], []] as const, others: [], archived: [] } }
      : {}
    groups.push({
      ...structured,
      key: g.key,
      workspaceId: g.workspaceId,
      cwd: g.cwd,
      createdAt: g.createdAt,
      label: g.label,
      sessionCount: g.sessions.length,
      expanded,
      containsCurrent: g.key === currentGroup,
      sessions: expanded
        ? g.sessions.map(session => sessionNode(session, descendants, statuses, roles))
        : [],
    })
  }
  return groups
}

/**
 * Select flat-list members without deriving row presentation or ordering.
 * @param list - sessions list snapshot.
 * @param archivedSessionIds - registry-global archive set.
 * @returns known visible Session ids in list order, including ordinary forks and only the current blank.
 */
export function visibleSessionIds(
  list: SessionListState,
  archivedSessionIds: readonly SessionId[],
  windows: WindowsView = NO_WINDOWS,
): SessionId[] {
  const archived = new Set(archivedSessionIds)
  const occupied = windowIds(windowRoles(windows), archived)
  const current = mainSessionId(list)
  return list.ids.filter((id) => {
    const s = list.byId[id]
    return s !== undefined && sessionVisible(s, current, archived, occupied)
  })
}

/**
 * Derive flat rows from the browser's ordered visible Session ids.
 * @param list - sessions list snapshot used to select the ids.
 * @param sessionIds - known visible members in render order, including any pinned blank.
 * @param statuses - unified UI status by Session.
 * @returns flat rows in the supplied order with current status indicators.
 */
export function deriveFlat(
  list: SessionListState,
  sessionIds: readonly SessionId[],
  statuses: SessionStatuses,
  windows: WindowsView = NO_WINDOWS,
): SessionNode[] {
  const descendants = indexSubagentDescendants(list.byId)
  const roles = windowRoles(windows)
  return sessionIds
    .map(id => sessionNode(list.byId[id] as SessionSummary, descendants, statuses, roles))
}

/**
 * Merge immediate title/Workspace substring matches with ranked Host content
 * matches. Local rows lead newest-first, content-only rows retain backend
 * order, and duplicate sessions receive the backend snippet in place.
 * @param list - session metadata authority.
 * @param workspaces - Workspace membership and display labels.
 * @param query - caller text; surrounding whitespace is ignored.
 * @param archivedSessionIds - registry-global archive set (members never match).
 * @param statuses - unified UI status by Session.
 * @param content - ranked Host content-search page.
 * @param limit - protocol-owned maximum merged row count.
 * @returns bounded deduplicated flat rows and a refine-query hint bit.
 */
export function deriveSearchResults(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  query: string,
  archivedSessionIds: readonly SessionId[],
  statuses: SessionStatuses,
  content: { items: readonly SessionSearchResultItem[]; hasMore: boolean },
  limit: number,
): SearchResultSet {
  const q = query.trim().toLowerCase()
  if (q === '') return { items: [], hasMore: false }
  const archived = new Set(archivedSessionIds)
  const noneOccupied = new Set<SessionId>()
  const descendants = indexSubagentDescendants(list.byId)
  const current = mainSessionId(list)

  const workspaceBySession = new Map<SessionId, string>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspace.title)
    }
  }
  const labelOf = (summary: SessionSummary): string =>
    workspaceBySession.get(summary.id) ?? workspaceLabel(summary.cwd)
  const contentBySession = new Map<SessionId, SessionSearchResultItem>()
  for (const item of content.items) {
    if (!contentBySession.has(item.sessionId)) contentBySession.set(item.sessionId, item)
  }

  const local: SessionSummary[] = []
  for (const id of list.ids) {
    const summary = list.byId[id]
    // Blank placeholders never match a query (their canonical title displays
    // localized, so matching it would tie search to one language).
    if (summary === undefined || summary.blank || !sessionVisible(summary, current, archived, noneOccupied)) continue
    if (
      sessionTitle(summary).toLowerCase().includes(q)
      || labelOf(summary).toLowerCase().includes(q)
    ) {
      local.push(summary)
    }
  }
  const localById = new Map(local.map(summary => [summary.id, summary]))
  const orderedLocal = orderByRecency(local.map(summary => summary.id), list.byId)
    .map(id => localById.get(id) as SessionSummary)

  const ordered: SessionSummary[] = []
  const included = new Set<SessionId>()
  const include = (summary: SessionSummary): void => {
    if (included.has(summary.id)) return
    included.add(summary.id)
    ordered.push(summary)
  }
  for (const summary of orderedLocal) include(summary)
  for (const item of content.items) {
    const summary = list.byId[item.sessionId]
    if (summary !== undefined && !summary.blank && sessionVisible(summary, current, archived, noneOccupied)) include(summary)
  }

  return {
    items: ordered.slice(0, limit).map((summary) => {
      const match = contentBySession.get(summary.id)
      const status = statuses.get(summary.id)
      const pendingInteraction = visiblePendingKind(status?.pendingInteraction?.kind)
      return {
        id: summary.id,
        title: sessionTitle(summary),
        workspace: labelOf(summary),
        running: status?.running ?? summary.running,
        runningSubagentCount: descendants.get(summary.id)?.runningCount ?? 0,
        ...(pendingInteraction === undefined
          ? {}
          : { pendingInteraction }),
        completed: status?.completionUnread === true,
        hasActiveSchedule: hasActiveSchedule(summary),
        ...match === undefined ? {} : { snippet: match.snippet },
      }
    }),
    hasMore: content.hasMore || ordered.length > limit,
  }
}

/** Normalize separators for comparison without interpreting POSIX backslashes as separators. */
function folderPath(path: string): string {
  const windows = /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
  return (windows ? path.replaceAll('\\', '/') : path).replace(/\/+$/, '')
}

/**
 * Find the nearest registered ancestor, excluding the Workspace directory itself.
 * Paths use Host spelling; matching is case-sensitive, like Workspace identity.
 * @param path - Workspace directory.
 * @param parents - registered Workspace directory paths.
 * @returns the owning parent path, or undefined when no parent contains the Workspace.
 */
export function owningParentFolder(path: string, parents: readonly string[]): string | undefined {
  const child = folderPath(path)
  let owner: string | undefined
  let length = -1
  for (const parent of parents) {
    const root = folderPath(parent)
    if (root.length > length && child !== root && child.startsWith(`${root}/`)) {
      owner = parent
      length = root.length
    }
  }
  return owner
}
