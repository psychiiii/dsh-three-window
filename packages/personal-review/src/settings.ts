/**
 * Reviewer settings: the volatile Config fields the `personal-settings` Host
 * row owns, and the `reviewSettings` service that row provides for
 * `review_debate`.
 *
 * dsh edits settings as `.volatile()` fields of a profile entry's Config and
 * persists them into the profile patch. `review_debate` runs on the review
 * preset's agent plane, which is not a profile entry, so the fields live on the
 * Host row and reach the tool through the service.
 * @module @psychiiii/dsh-three-window-review/settings
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  assertReviewerTable, MAX_REVIEWERS,
  type ReviewSettings, type ReviewerSettingsRow,
} from './reviewers.ts'

export {
  EMPTY_REVIEWERS_MESSAGE, MAX_REVIEWERS, REVIEW_PRESET, REVIEW_SETTINGS_ENTRY,
  assertReviewerTable, perspectiveFromSection, requireConfiguredReviewers, reviewersFromSection,
  parseReviewerRow, toReviewerSpecs, validReviewerRows,
  type ReviewSettings, type ReviewerSettingsRow,
} from './reviewers.ts'

const reviewerRow = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  effort: z.string(),
  role: z.string(),
})

/**
 * Reviewer table: 0–5 rows, where empty provider+model rows are unused slots.
 * The transform runs the cross-field checks the row schema cannot express
 * (incomplete rows, duplicate reviewers, duplicate roles), so a settings write
 * that breaks them is refused by the Host's Config validation. The stored
 * value is the table as written; the transform only rejects.
 */
export const ReviewerTableSchema = z.transform(
  z.array(reviewerRow).max(MAX_REVIEWERS),
  (rows) => {
    assertReviewerTable(rows as ReviewerSettingsRow[])
    return rows
  },
).default([])

/**
 * Config fields of the `personal-settings` Host row, both editable live.
 *
 * `perspective` is free text that reaches every seat's perspective section and
 * nothing else: it can never replace the seat system prompt or the output
 * protocol, both of which are constants in `prompts.ts`. Blank — the default —
 * sends the built-in `DEFAULT_PERSPECTIVE`. Nothing validates the wording: a
 * keyword blocklist is bypassable and misfires on legitimate text, and a
 * guarantee that can be walked around is worse than none, so the field's
 * stated scope plus the page's warning are the whole defence.
 */
export const ReviewSettingsConfig = z.object({
  reviewers: ReviewerTableSchema.volatile(),
  perspective: z.string().default('').volatile(),
})

/** Resolved Config of the `personal-settings` Host row: live references, read with `get()`. */
export interface ReviewSettingsConfig {
  /** Reviewer table as last written. */
  reviewers: Volatile<ReviewerSettingsRow[]>
  /** Perspective text as last written; blank means the built-in default. */
  perspective: Volatile<string>
}

/** Current reviewer settings, read at the moment `review_debate` runs. */
export interface ReviewSettingsService {
  /** @returns the reviewer table and perspective as the profile holds them now. */
  current(): ReviewSettings
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Reviewer settings; provided by the `personal-settings` Host row. */
    reviewSettings: ReviewSettingsService
  }
}

/**
 * Provide `ctx.reviewSettings` over the row's volatile Config references.
 * @param ctx - the `personal-settings` Host row's context.
 * @param config - that row's resolved Config.
 */
export function provideReviewSettings(ctx: Context, config: ReviewSettingsConfig): void {
  ctx.provide('reviewSettings', {
    current: () => ({
      reviewers: config.reviewers.get(),
      perspective: config.perspective.get(),
    }),
  })
}
