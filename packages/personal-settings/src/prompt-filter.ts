/**
 * Leave out the parts of dsh's own system prompt that are written for people
 * developing dsh itself, without touching dsh: a listener on dsh's
 * `system-prompt/assemble` waterfall edits the finished assembly.
 *
 * The three windows serve people doing any kind of work in their workspace.
 * Two dsh sections speak only to dsh developers and pull the model toward
 * treating every user as one: where the dsh source checkout lives, and how the
 * Web GUI's hot reload and build work. A third, the bash exit-code rule, is
 * noise in a window that has no bash tool (the review window). What stays of
 * the Web GUI section is its first part: which page the user is on and what
 * "this page" means.
 * @module @psychiiii/dsh-three-window-settings/prompt-filter
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

/** dsh's section naming where the dsh source checkout lives (`@deepseek-ai/dsh-app-boot`). */
export const HARNESS_SOURCE_SECTION = 'harness:source'

/** dsh's Web GUI section (`@deepseek-ai/dsh-bundle-web-app`). */
export const WEB_SURFACE_SECTION = 'app:web-surface'

/** Where the Web GUI section turns to dsh development; the text from here on is dropped. */
export const WEB_SURFACE_DEVELOPER_PART = 'The client-plugin HMR receiver'

/** dsh's bash exit-code rule (`@deepseek-ai/dsh-tool-bash`). */
export const BASH_SECTION = 'tool:bash'

/**
 * The assembly without the developer-only parts.
 * @param assembly - the finished assembly for one window's model step.
 * @returns the same assembly with those sections removed or cut.
 */
export function withoutDeveloperSections(assembly: PromptAssembly): PromptAssembly {
  const hasBash = assembly.tools.some(tool => tool.name === 'bash')
  const sections = assembly.sections.flatMap((section) => {
    if (section.name === HARNESS_SOURCE_SECTION) return []
    if (section.name === BASH_SECTION && !hasBash) return []
    if (section.name === WEB_SURFACE_SECTION) {
      const cut = section.text.indexOf(WEB_SURFACE_DEVELOPER_PART)
      return cut < 0 ? [section] : [{ ...section, text: section.text.slice(0, cut).trimEnd() }]
    }
    return [section]
  })
  return { ...assembly, sections }
}

/**
 * Register the filter on every window's assembly.
 * @param ctx - the Host row's context.
 */
export function applyPromptFilter(ctx: Context): void {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => withoutDeveloperSections(await next()))
}
