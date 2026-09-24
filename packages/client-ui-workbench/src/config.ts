/**
 * Workbench window-bootstrap strategy. Host Config is the cordis.yml face;
 * the Host injects the resolved value for the Client plugin to read.
 * @module @psychiiii/dsh-three-window-workbench/config
 */

import z from '@deepseek-ai/schemastery'
import { PROJECT_ROOT_EMPTY } from './project-root.ts'

/** Left-to-right pane count `bind` and bootstrap both require. */
export const WORKBENCH_WINDOW_COUNT = 3

/** Page global the Host injects so the Client plugin can read Config. */
export const WORKBENCH_BOOT_GLOBAL = '__DSH_WORKBENCH__'

/** How bootstrap chooses an existing Session for one pane. */
export type WorkbenchReuseStrategy = 'recent-matching-preset'

/**
 * Official permission preset names a window row may name. No other string is
 * accepted, including `auto`.
 */
export const WORKBENCH_PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** One official permission preset used as a new-Session default. */
export type WorkbenchPermission = (typeof WORKBENCH_PERMISSIONS)[number]

/** One pane's create/reuse policy, in left-to-right order. */
export interface WorkbenchWindowConfig {
  /** Agent preset id passed to Host `session.create` so the log header records it. */
  agentPreset: string
  /**
   * Official permission preset applied with `/permission` after create.
   * Required on every row when `windows` has three entries. Reuse never
   * writes this value.
   */
  permission: WorkbenchPermission
}

/** Workbench plugin config: window count is `windows.length`. */
export interface Config {
  /**
   * Left-to-right pane rows. Empty disables bootstrap (`bind` stays the
   * caller). Length other than 0 or {@link WORKBENCH_WINDOW_COUNT} fails load.
   */
  windows?: WorkbenchWindowConfig[]
  /**
   * Reuse the most recently updated listed Session whose projected
   * `agentPreset` matches the pane; otherwise Host `session.create` with
   * that preset.
   */
  reuse?: WorkbenchReuseStrategy
  /**
   * Absolute project directory for the three windows. Overlay and profile
   * patches may set this; it is not Host home and has no schema default.
   */
  projectRoot?: string
}

/**
 * Page-global payload the Host injects. `hostCwd` is not a cordis.yml field;
 * the Host writes `process.cwd()` when serving the page.
 */
export interface WorkbenchBootPayload extends Config {
  /** Server process cwd captured at inject; never `$host.home`. */
  hostCwd?: string
}

/** Resolved bootstrap strategy after schema defaults. */
export interface ResolvedWorkbenchConfig {
  readonly windows: readonly WorkbenchWindowConfig[]
  readonly reuse: WorkbenchReuseStrategy
  /** Explicit `config.projectRoot` when set and non-empty. */
  readonly projectRoot: string | undefined
  /** Host-injected server cwd when the page global carried one. */
  readonly hostCwd: string | undefined
}

const windowSchema = z.object({
  agentPreset: z.string().required(),
  permission: z.string(),
})

/** Schemastery configuration for the workbench Host row and Client apply. */
export const Config = z.object({
  windows: z.array(windowSchema).default([]),
  reuse: z.const('recent-matching-preset').default('recent-matching-preset'),
  projectRoot: z.string(),
})

/**
 * Validate plugin config and fill schema defaults.
 * @param config - Host row, Client apply argument, or injected page global.
 * @returns windows, reuse strategy, optional project root, and optional Host cwd.
 * @throws when `windows` is not empty and not length 3, a preset is blank, a
 *   three-row window omits `permission` or names an unknown preset, or
 *   `projectRoot` is present and empty.
 */
export function resolveWorkbenchConfig(config: WorkbenchBootPayload = {}): ResolvedWorkbenchConfig {
  const hostCwd = typeof config.hostCwd === 'string' && config.hostCwd.length > 0
    ? config.hostCwd
    : undefined
  const resolved = Config(config)
  const windows = resolved.windows as WorkbenchWindowConfig[]
  const reuse = resolved.reuse as WorkbenchReuseStrategy
  if (windows.length !== 0 && windows.length !== WORKBENCH_WINDOW_COUNT) {
    throw new Error(
      `ui-workbench config.windows must be empty or length ${String(WORKBENCH_WINDOW_COUNT)}`,
    )
  }
  let nextWindows: WorkbenchWindowConfig[] = windows
  if (windows.length === WORKBENCH_WINDOW_COUNT) {
    const rawWindows = config.windows === undefined ? windows : config.windows
    nextWindows = windows.map((window, index) => {
      if (window.agentPreset.length === 0) {
        throw new Error('ui-workbench window agentPreset must be non-empty')
      }
      const raw = rawWindows[index]
      const permission = typeof raw?.permission === 'string' ? raw.permission : window.permission
      if (typeof permission !== 'string' || permission.length === 0) {
        throw new Error(`ui-workbench config.windows[${String(index)}] permission is required`)
      }
      if (!isWorkbenchPermission(permission)) {
        throw new Error(
          `ui-workbench config.windows[${String(index)}] permission ${JSON.stringify(permission)} is unknown (available: ${WORKBENCH_PERMISSIONS.join(', ')})`,
        )
      }
      return { agentPreset: window.agentPreset, permission }
    })
  } else {
    for (const window of windows) {
      if (window.agentPreset.length === 0) {
        throw new Error('ui-workbench window agentPreset must be non-empty')
      }
    }
  }
  if (config.projectRoot !== undefined && config.projectRoot.length === 0) {
    throw new Error(PROJECT_ROOT_EMPTY)
  }
  const projectRoot = typeof resolved.projectRoot === 'string' && resolved.projectRoot.length > 0
    ? resolved.projectRoot
    : undefined
  return { windows: nextWindows, reuse, projectRoot, hostCwd }
}

/**
 * Read the Host-injected bootstrap global, if the page carries one.
 * @returns the injected value, or undefined when the Host did not inject.
 */
export function readInjectedWorkbenchConfig(): unknown {
  return (globalThis as { [WORKBENCH_BOOT_GLOBAL]?: unknown })[WORKBENCH_BOOT_GLOBAL]
}

/**
 * Prefer an apply argument that already names three windows (tests).
 * Otherwise read the Host-injected page global. An empty apply `{}` from
 * the Client Loader must not hide that global.
 * @param config - optional apply argument.
 * @returns resolved windows, reuse strategy, and project-root sources.
 */
export function resolveClientWorkbenchConfig(config?: WorkbenchBootPayload): ResolvedWorkbenchConfig {
  if (config !== undefined) {
    const fromApply = resolveWorkbenchConfig(config)
    if (fromApply.windows.length === WORKBENCH_WINDOW_COUNT) return fromApply
  }
  const injected = readInjectedWorkbenchConfig()
  if (injected !== undefined) return resolveWorkbenchConfig(injected as WorkbenchBootPayload)
  return resolveWorkbenchConfig(config ?? {})
}

function isWorkbenchPermission(value: string): value is WorkbenchPermission {
  return (WORKBENCH_PERMISSIONS as readonly string[]).includes(value)
}
