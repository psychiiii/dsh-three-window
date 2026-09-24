/**
 * Host registration for the three-window workbench. Validates Config and
 * injects the resolved bootstrap strategy into each served page.
 * @module @psychiiii/dsh-three-window-workbench
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, resolveWorkbenchConfig, WORKBENCH_BOOT_GLOBAL } from './config.ts'

export {
  Config, resolveWorkbenchConfig, WORKBENCH_BOOT_GLOBAL, WORKBENCH_PERMISSIONS,
  WORKBENCH_WINDOW_COUNT,
  type ResolvedWorkbenchConfig, type WorkbenchBootPayload, type WorkbenchPermission,
  type WorkbenchReuseStrategy, type WorkbenchWindowConfig,
} from './config.ts'
export {
  normalizeProjectPath, PROJECT_ROOT_EMPTY, PROJECT_ROOT_IS_HOST_HOME, PROJECT_ROOT_MISSING,
  resolveProjectRoot, sameProjectPath, selectExistingWorkspace,
  type ProjectRootRequest, type ProjectRootSource, type ProjectRootSpec,
  type ProjectRootWorkspace,
} from './project-root.ts'

/**
 * Inject the resolved window-bootstrap strategy for the Client plugin.
 * `hostCwd` is `process.cwd()` at inject time, not a Config default.
 * @param ctx - Host context.
 * @param config - cordis.yml row; empty `windows` disables Client bootstrap.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveWorkbenchConfig(config)
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: WORKBENCH_BOOT_GLOBAL,
      value: {
        windows: resolved.windows,
        reuse: resolved.reuse,
        hostCwd: process.cwd(),
        ...(resolved.projectRoot === undefined ? {} : { projectRoot: resolved.projectRoot }),
      },
    })
  })
}
