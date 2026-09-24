/**
 * Explicit project-root resolution for three-window bootstrap and create.
 * `$host.home` is never a source.
 * @module @psychiiii/dsh-three-window-workbench/project-root
 */

/** Config named a blank `projectRoot`. */
export const PROJECT_ROOT_EMPTY = 'workbench config.projectRoot must be a non-empty path'

/** Config named the Host home directory. */
export const PROJECT_ROOT_IS_HOST_HOME =
  'workbench config.projectRoot must not be the host home directory'

/** No remaining source after skipping Host home. */
export const PROJECT_ROOT_MISSING = [
  'workbench project root is missing: set config.projectRoot to a project directory',
  'or start dsh from a project directory (not the host home)',
].join(', ')

/** Which request field produced {@link ProjectRootSpec.path}. */
export type ProjectRootSource = 'workspace' | 'config' | 'host-cwd'

/** One listed Workspace enough for recency pick and path match. */
export interface ProjectRootWorkspace {
  readonly path: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
}

/**
 * Inputs for {@link resolveProjectRoot}. Callers fill this object; the
 * function does not read `process.cwd()`, `$host.home`, or schema defaults.
 */
export interface ProjectRootRequest {
  /** Listed workspaces in Host order. */
  readonly workspaces: readonly ProjectRootWorkspace[]
  /** `updatedAt` for listed Sessions, keyed by Session id. */
  readonly sessionUpdatedAt: Readonly<Record<string, number>>
  /** Overlay / profile `config.projectRoot` after schema parse. */
  readonly configProjectRoot: string | undefined
  /** Host-injected `process.cwd()` captured when the page was served. */
  readonly hostCwd: string | undefined
  /** `remote.$host.home`; undefined until the ready frame. */
  readonly hostHome: string | undefined
}

/** Resolved project directory and the source that produced it. */
export interface ProjectRootSpec {
  readonly path: string
  readonly source: ProjectRootSource
}

/**
 * Compare two absolute project paths. Trailing slashes do not distinguish
 * roots; the comparison is case-sensitive.
 * @param left - first path.
 * @param right - second path.
 * @returns true when both name the same directory.
 */
export function sameProjectPath(left: string, right: string): boolean {
  return normalizeProjectPath(left) === normalizeProjectPath(right)
}

/**
 * Strip trailing slashes except the root `/`.
 * @param path - absolute path.
 * @returns the normalized path.
 */
export function normalizeProjectPath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.replace(/\/+$/u, '') || '/'
  return path
}

/**
 * Resolve the three-window project root.
 *
 * Order:
 * 1. Existing listed workspace: when `config.projectRoot` is set, the
 *    workspace whose path equals it; otherwise the most recently updated
 *    workspace that is not Host home.
 * 2. `config.projectRoot` when set. A value equal to Host home throws.
 * 3. `hostCwd` when set and not Host home.
 * 4. Otherwise throws {@link PROJECT_ROOT_MISSING}.
 *
 * `$host.home` is never returned. Reuse of a Session still requires that
 * Session's `cwd` or its workspace path equal this spec.
 * @param request - listed workspaces, optional config, Host cwd, Host home.
 * @returns the project directory and its source.
 * @throws {@link PROJECT_ROOT_EMPTY} when config is present and blank.
 * @throws {@link PROJECT_ROOT_IS_HOST_HOME} when config equals Host home.
 * @throws {@link PROJECT_ROOT_MISSING} when no remaining source is a project.
 */
export function resolveProjectRoot(request: ProjectRootRequest): ProjectRootSpec {
  const home = nonempty(request.hostHome)
  const configured = parseConfigProjectRoot(request.configProjectRoot)
  if (configured !== undefined && home !== undefined && sameProjectPath(configured, home)) {
    throw new Error(PROJECT_ROOT_IS_HOST_HOME)
  }

  if (configured !== undefined) {
    const matched = request.workspaces.find(workspace => sameProjectPath(workspace.path, configured))
    if (matched !== undefined) return { path: matched.path, source: 'workspace' }
    return { path: configured, source: 'config' }
  }

  const existing = selectExistingWorkspace(request.workspaces, request.sessionUpdatedAt, home)
  if (existing !== undefined) return { path: existing.path, source: 'workspace' }

  const cwd = nonempty(request.hostCwd)
  if (cwd !== undefined && (home === undefined || !sameProjectPath(cwd, home))) {
    return { path: cwd, source: 'host-cwd' }
  }
  throw new Error(PROJECT_ROOT_MISSING)
}

/**
 * Recency-pick a listed workspace, skipping Host home.
 * @param workspaces - listed workspaces in Host order.
 * @param sessionUpdatedAt - Session `updatedAt` by id.
 * @param hostHome - Host home to exclude; undefined skips no extra paths.
 * @returns the newest non-home workspace, or undefined.
 */
export function selectExistingWorkspace(
  workspaces: readonly ProjectRootWorkspace[],
  sessionUpdatedAt: Readonly<Record<string, number>>,
  hostHome: string | undefined,
): ProjectRootWorkspace | undefined {
  let selected: ProjectRootWorkspace | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    if (hostHome !== undefined && sameProjectPath(workspace.path, hostHome)) continue
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const updatedAt = sessionUpdatedAt[sessionId]
      if (updatedAt !== undefined) latest = Math.max(latest, updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace
      selectedTime = latest
    }
  }
  return selected
}

function parseConfigProjectRoot(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.length === 0) throw new Error(PROJECT_ROOT_EMPTY)
  return value
}

function nonempty(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined
  return value
}
