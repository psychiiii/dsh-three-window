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
  MAX_REVIEWERS,
  type ReviewSettings, type ReviewerSettingsRow,
} from './reviewers.ts'
import {
  OUTPUT_LANGUAGE_VALUES, UNSPECIFIED_OUTPUT_LANGUAGE, outputLanguagesFromSection,
  type OutputLanguageSettings,
} from './output-language.ts'
import {
  WORKSPACE_PROMPT_ENTRIES_MAX, WORKSPACE_PROMPT_MAX, workspacePromptsFromSection,
  type WorkspacePromptEntry,
} from './workspace-prompt.ts'

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
 *
 * Only serializable constraints live here. The Host sends this schema to the
 * browser as JSON, and the settings form rehydrates and validates the stored
 * value with it before showing anything; a `transform` arrives there without
 * its callback, every validation throws, and the form stays "loading" forever.
 * So the cross-field checks the row schema cannot express (incomplete rows,
 * duplicate reviewers, duplicate roles) run where the table is written — the
 * settings page refuses before saving — and where it is used —
 * `review_debate` refuses a bad table through `requireConfiguredReviewers`.
 */
export const ReviewerTableSchema = z.array(reviewerRow).max(MAX_REVIEWERS).default([])

/**
 * One window's output language: a table tag or blank for "not specified".
 * A union of string constants, which serializes to the browser intact.
 */
export const OutputLanguageValueSchema = z.union([...OUTPUT_LANGUAGE_VALUES] as [string, ...string[]])
  .default(UNSPECIFIED_OUTPUT_LANGUAGE)

/** Output language per window. */
export const OutputLanguageSchema = z.object({
  chat: OutputLanguageValueSchema,
  construct: OutputLanguageValueSchema,
  review: OutputLanguageValueSchema,
})

/** Per-Workspace turn prompts, keyed by root path; length limits only, which serialize. */
export const WorkspacePromptsSchema = z.array(z.object({
  root: z.string(),
  prompt: z.string().max(WORKSPACE_PROMPT_MAX),
})).max(WORKSPACE_PROMPT_ENTRIES_MAX).default([])

/**
 * Config fields of the `personal-settings` Host row, all editable live.
 *
 * `outputLanguage` holds one table tag (or blank) per window and reaches models
 * only through `output-language.ts`, which renders fixed text from the tag;
 * `outputLanguagePrompted` records that the first-entry prompt was answered.
 * `workspacePrompts` holds each Workspace's turn prompt, keyed by root path.
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
  outputLanguage: OutputLanguageSchema.volatile(),
  outputLanguagePrompted: z.boolean().default(false).volatile(),
  workspacePrompts: WorkspacePromptsSchema.volatile(),
})

/** Resolved Config of the `personal-settings` Host row: live references, read with `get()`. */
export interface ReviewSettingsConfig {
  /** Reviewer table as last written. */
  reviewers: Volatile<ReviewerSettingsRow[]>
  /** Perspective text as last written; blank means the built-in default. */
  perspective: Volatile<string>
  /** Output language per window as last written. */
  outputLanguage: Volatile<Partial<OutputLanguageSettings>>
  /** Whether the first-entry output-language prompt has been answered. */
  outputLanguagePrompted: Volatile<boolean>
  /** Per-Workspace turn prompts as last written. */
  workspacePrompts: Volatile<WorkspacePromptEntry[]>
}

/** Current reviewer settings, read at the moment `review_debate` runs. */
export interface ReviewSettingsService {
  /** @returns the reviewer table and perspective as the profile holds them now. */
  current(): ReviewSettings
  /** @returns each window's output language as the profile holds it now; unknown values read as unspecified. */
  outputLanguages(): OutputLanguageSettings
  /** @returns the usable per-Workspace turn prompts as the profile holds them now. */
  workspacePrompts(): WorkspacePromptEntry[]
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
    outputLanguages: () => outputLanguagesFromSection({ outputLanguage: config.outputLanguage.get() }),
    workspacePrompts: () => workspacePromptsFromSection({ workspacePrompts: config.workspacePrompts.get() }),
  })
}
