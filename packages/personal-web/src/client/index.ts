/**
 * Browser half of the three-window bundle: the four overlay browser halves
 * composed in one ModuleLoader factory.
 *
 * Each half is its own Cordis plugin under this one, so each keeps its own
 * service `inject` list and lifetime. Plug order is the order their rows had in
 * `cordis.patch.yml` before the halves were composed here (workbench, sidebar,
 * workspace, settings), preceded by the Session retention provider that the
 * workbench and workspace halves inject. The sidebar and workspace halves both
 * register sidebar slots, so reordering them changes which registration a
 * slot sees first.
 *
 * Package edges for module arrival (`dsh.client.inject` in this package's
 * manifest) are the union of the four halves' declarations.
 * @module @psychiiii/dsh-three-window/client
 */

import type { Context } from '@deepseek-ai/cordis'
import * as settings from '@psychiiii/dsh-three-window-settings/client'
import * as sidebar from '@psychiiii/dsh-three-window-sidebar/client'
import * as workbench from '@psychiiii/dsh-three-window-workbench/client'
import { SessionRetentionProvider, type WorkbenchBootPayload } from '@psychiiii/dsh-three-window-workbench/client'
import * as workspace from '@psychiiii/dsh-three-window-workspace/client'

/** Cordis plugin name of the composed browser half. */
export const name = 'dsh-three-window'

/**
 * Plug the retention provider and the four browser halves in their fixed order.
 * @param ctx - client root context.
 * @param config - apply argument; forwarded unchanged as the workbench half's
 *   config, which falls back to the Host-injected page global when it does not
 *   carry three windows.
 */
export function apply(ctx: Context, config?: WorkbenchBootPayload): void {
  ctx.plugin(SessionRetentionProvider)
  ctx.plugin(workbench, config)
  ctx.plugin(sidebar)
  ctx.plugin(workspace)
  ctx.plugin(settings)
}
