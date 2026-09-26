/**
 * Host half of the personal overlay's settings row (`personal-settings`).
 *
 * The row owns the reviewer settings: its Config's volatile `reviewers` and
 * `perspective` fields are what the settings page edits through
 * `configForms.get('personal-settings')`, and it provides
 * `ctx.reviewSettings` for `review_debate`. The fields sit here, not on the
 * `personal-review` row, because dsh edits only the Config of profile entries
 * and `personal-review` is an agent-plane row on the review preset — that is
 * where `review_debate` belongs, and it keeps the tool out of the chat and
 * construct catalogs.
 *
 * It also carries the per-turn context of the three windows: the same Config
 * holds one output language per window and one turn prompt per Workspace, and
 * this row appends both on every user turn (`turn-injections.ts`).
 *
 * The row also keeps its original reason to exist: the Web client composition
 * is built from the Host entry graph, and this row's package root carries
 * the review page and dock in the composed browser half.
 * @module @psychiiii/dsh-three-window-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import {
  provideReviewSettings, ReviewSettingsConfig,
} from '@psychiiii/dsh-three-window-review/settings'
import { outputLanguagesFromSection } from '@psychiiii/dsh-three-window-review/output-language'
import { workspacePromptsFromSection } from '@psychiiii/dsh-three-window-review/workspace-prompt'
import { applyTurnInjections } from './turn-injections.ts'

export {
  OUTPUT_LANGUAGE_SOURCE_KIND, WORKSPACE_PROMPT_SOURCE_KIND,
  applyTurnInjections, turnInjections, workspacePromptFor,
  type TurnSettings,
} from './turn-injections.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'personal-settings'

/** Reviewer table, perspective, output languages, and Workspace prompts, all volatile (edited live). */
export const Config = ReviewSettingsConfig

/** Resolved Config of this row. */
export type Config = import('@psychiiii/dsh-three-window-review/settings').ReviewSettingsConfig

/**
 * Provide `ctx.reviewSettings`, append the per-turn context on each window's
 * turns, and turn off the generated settings form for this row: the
 * 「窗口与评审」 page, the General rows, and the Workspace menu are its editors.
 * @param ctx - host context.
 * @param config - the row's resolved Config.
 */
export function apply(ctx: Context, config: Config): void {
  provideReviewSettings(ctx, config)
  ctx.inject(['sessionProjections'], (child) => {
    applyTurnInjections(child, () => ({
      languages: outputLanguagesFromSection({ outputLanguage: config.outputLanguage.get() }),
      workspacePrompts: workspacePromptsFromSection({ workspacePrompts: config.workspacePrompts.get() }),
    }))
  })
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'personal-settings: own settings page')
  })
}
