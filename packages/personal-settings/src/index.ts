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

/** Cordis plugin name used by loader diagnostics. */
export const name = 'personal-settings'

/** Reviewer table and perspective, both volatile (edited live from the settings page). */
export const Config = ReviewSettingsConfig

/** Resolved Config of this row. */
export type Config = import('@psychiiii/dsh-three-window-review/settings').ReviewSettingsConfig

/**
 * Provide `ctx.reviewSettings` and turn off the generated settings form for
 * this row: the 「窗口与评审」 page is its editor.
 * @param ctx - host context.
 * @param config - the row's resolved Config.
 */
export function apply(ctx: Context, config: Config): void {
  provideReviewSettings(ctx, config)
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'personal-settings: own settings page')
  })
}
