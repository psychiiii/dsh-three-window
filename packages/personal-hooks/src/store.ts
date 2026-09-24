/**
 * Per-project `.dsh/hooks/` cache with fs watch and reference replacement.
 * @module @psychiiii/dsh-three-window-hooks/store
 */

import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { parseDshHookConfig, selectHookConfig, type DshHookConfig, type HookFileState } from './config.ts'
import { DEFAULT_HOOK_FILE, WINDOW_KEYS, type WindowKey } from './windows.ts'

/** Directory under the project cwd that holds window hook files. */
export const HOOKS_RELATIVE_DIR = join('.dsh', 'hooks')

export type { HookFileState } from './config.ts'

/** Loaded groups for one project cwd. Replaced as a whole on reload. */
export interface ProjectHookGroups {
  readonly byWindow: ReadonlyMap<WindowKey, HookFileState>
  readonly defaultFile: HookFileState | undefined
}

/** Logger subset used when a file fails to parse. */
export interface HookLogger {
  error(message: string): void
}

/** Per-cwd hook cache with watchers torn down by {@link HookStore.dispose}. */
export class HookStore {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly logger: HookLogger
  private disposed = false

  /**
   * @param logger - receives parse failures; the matching window group is then disabled.
   */
  constructor(logger: HookLogger) {
    this.logger = logger
  }

  /**
   * Absolute path of one project's hook directory.
   * @param cwd - session workspace, the project root.
   * @returns `<cwd>/.dsh/hooks`.
   */
  hooksDir(cwd: string): string {
    return join(cwd, HOOKS_RELATIVE_DIR)
  }

  /**
   * Choose the runnable config for one window under the three-level rule:
   * window file if present and valid; else `default.json` if present and valid;
   * else no hooks. A present but invalid window file disables that window
   * without falling back to default.
   * @param cwd - session workspace.
   * @param window - window filename stem.
   * @returns parsed groups, or undefined when that window runs no hooks.
   */
  select(cwd: string, window: WindowKey): DshHookConfig | undefined {
    const groups = this.groups(cwd)
    const choice = selectHookConfig(groups.byWindow.get(window), groups.defaultFile)
    return choice.source === 'none' ? undefined : choice.config
  }

  /**
   * Current groups for `cwd`, loading and watching on first access.
   * @param cwd - session workspace.
   * @returns the current groups reference (replaced on reload).
   */
  groups(cwd: string): ProjectHookGroups {
    let entry = this.cache.get(cwd)
    if (entry === undefined) {
      entry = { groups: emptyGroups(), watcher: undefined, debounce: undefined }
      this.cache.set(cwd, entry)
      this.reload(cwd)
      this.ensureWatch(cwd)
    } else if (entry.watcher === undefined) {
      this.ensureWatch(cwd)
    }
    return entry.groups
  }

  /**
   * Re-read hook files and replace the groups reference. Missing files are
   * omitted; present invalid files are recorded as `invalid` and logged.
   * @param cwd - session workspace.
   */
  reload(cwd: string): void {
    if (this.disposed) return
    const entry = this.cache.get(cwd) ?? { groups: emptyGroups(), watcher: undefined, debounce: undefined }
    this.cache.set(cwd, entry)
    const dir = this.hooksDir(cwd)
    const byWindow = new Map<WindowKey, HookFileState>()
    for (const key of WINDOW_KEYS) {
      const state = this.readFile(join(dir, `${key}.json`))
      if (state !== undefined) byWindow.set(key, state)
    }
    entry.groups = {
      byWindow,
      defaultFile: this.readFile(join(dir, `${DEFAULT_HOOK_FILE}.json`)),
    }
  }

  /**
   * Close watchers and debounce timers. In-flight hook processes are owned by
   * the plugin's detached-run tracker, not this store.
   */
  dispose(): void {
    this.disposed = true
    for (const entry of this.cache.values()) {
      if (entry.debounce !== undefined) clearTimeout(entry.debounce)
      entry.watcher?.close()
    }
    this.cache.clear()
  }

  private readFile(path: string): HookFileState | undefined {
    if (!existsSync(path)) return undefined
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return { status: 'ok', config: parseDshHookConfig(raw, path) }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const diagnostic = `personal-hooks: failed to parse ${path}: ${message} — that window group is disabled`
      this.logger.error(diagnostic)
      return { status: 'invalid', error: diagnostic }
    }
  }

  private ensureWatch(cwd: string): void {
    const entry = this.cache.get(cwd)
    if (entry === undefined || entry.watcher !== undefined) return
    const dir = this.hooksDir(cwd)
    const dshDir = join(cwd, '.dsh')
    const target = existsSync(dir) ? dir : existsSync(dshDir) ? dshDir : existsSync(cwd) ? cwd : undefined
    if (target === undefined) return
    try {
      const watcher = watch(target, () => {
        if (entry.debounce !== undefined) clearTimeout(entry.debounce)
        entry.debounce = setTimeout(() => {
          entry.debounce = undefined
          this.reload(cwd)
          if (entry.watcher === undefined) this.ensureWatch(cwd)
        }, 50)
      })
      watcher.on('error', () => {
        entry.watcher = undefined
      })
      entry.watcher = watcher
    } catch {
      entry.watcher = undefined
    }
  }
}

interface CacheEntry {
  groups: ProjectHookGroups
  watcher: FSWatcher | undefined
  debounce: ReturnType<typeof setTimeout> | undefined
}

function emptyGroups(): ProjectHookGroups {
  return { byWindow: new Map(), defaultFile: undefined }
}
