/**
 * Reviewer table shared by settings, `review_debate`, and the review-window dock.
 * Pure: no I/O, no schemastery, safe to import from the client bundle.
 * @module @psychiiii/dsh-three-window-review/reviewers
 */

import type { ReviewerSpec } from './args.ts'

/** Agent preset id that owns the review window and `review_debate`. */
export const REVIEW_PRESET = 'personal-review'

/**
 * Profile entry id whose volatile Config holds the reviewer table and the
 * perspective (the `personal-settings` row of `cordis.patch.yml`). The settings
 * page edits it through `configForms.get(REVIEW_SETTINGS_ENTRY)`.
 */
export const REVIEW_SETTINGS_ENTRY = 'personal-settings'

/** Inclusive cap on the settings `reviewers` array, including empty rows. */
export const MAX_REVIEWERS = 5

/**
 * Tool error and dock empty-state copy when no valid reviewer row is stored.
 * The Chinese sentence is the product-required guidance.
 */
export const EMPTY_REVIEWERS_MESSAGE =
  '尚未配置评审模型，请在 review 窗的『评审模型』按钮里至少配置一组 provider + model'

/** One settings row. Empty provider and model together means "unused slot". */
export interface ReviewerSettingsRow {
  readonly provider: string
  readonly model: string
  readonly effort?: string
  readonly role?: string
}

/** Reviewer settings as the `personal-settings` entry's Config holds them. */
export interface ReviewSettings {
  readonly reviewers: readonly ReviewerSettingsRow[]
  /**
   * Free text appended to every seat's perspective section. Blank means the
   * built-in default perspective; see `resolvePerspective` in `prompts.ts`.
   */
  readonly perspective: string
}

function trimOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Keep rows whose provider and model are both non-empty. Completely empty
 * rows are dropped. A row with only one of provider/model set is rejected.
 * @param rows - stored or drafted table.
 * @returns normalized valid rows.
 * @throws when a row sets only provider or only model.
 */
export function validReviewerRows(rows: readonly ReviewerSettingsRow[]): ReviewerSettingsRow[] {
  const valid: ReviewerSettingsRow[] = []
  for (const row of rows) {
    const provider = row.provider.trim()
    const model = row.model.trim()
    if (provider.length === 0 && model.length === 0) continue
    if (provider.length === 0 || model.length === 0) {
      throw new Error('personal-review reviewer rows must set both provider and model, or leave both empty')
    }
    const effort = trimOptional(row.effort)
    const role = trimOptional(row.role)
    valid.push({
      provider,
      model,
      ...effort !== undefined ? { effort } : {},
      ...role !== undefined ? { role } : {},
    })
  }
  return valid
}

/**
 * Reject more than {@link MAX_REVIEWERS} rows, incomplete rows, and duplicate
 * provider+model (or duplicate explicit roles). Empty slots are allowed.
 * @param rows - stored or drafted table.
 * @returns normalized valid rows (length 0–5).
 */
export function assertReviewerTable(rows: readonly ReviewerSettingsRow[]): ReviewerSettingsRow[] {
  if (rows.length > MAX_REVIEWERS) {
    throw new Error(`personal-review reviewers must have at most ${String(MAX_REVIEWERS)} rows, got ${String(rows.length)}`)
  }
  const valid = validReviewerRows(rows)
  const seen = new Set<string>()
  const roles = new Set<string>()
  for (const row of valid) {
    const key = `${row.provider}\0${row.model}`
    if (seen.has(key)) {
      throw new Error(`personal-review duplicate reviewer ${row.provider}/${row.model}`)
    }
    seen.add(key)
    if (row.role !== undefined) {
      if (roles.has(row.role)) {
        throw new Error(`personal-review reviewer role ${JSON.stringify(row.role)} is duplicated`)
      }
      roles.add(row.role)
    }
  }
  return valid
}

/**
 * Map valid settings rows onto seat specs. Missing `role` becomes `reviewer-N`
 * in valid-row order. `effort` becomes `reasoningEffort`. A leftover
 * `persona` field on stored settings is ignored and never forwarded.
 * @param rows - stored or drafted table.
 */
export function toReviewerSpecs(rows: readonly ReviewerSettingsRow[]): ReviewerSpec[] {
  return assertReviewerTable(rows).map((row, index) => ({
    role: trimOptional(row.role) ?? `reviewer-${String(index + 1)}`,
    provider: row.provider,
    model: row.model,
    ...row.effort !== undefined ? { reasoningEffort: row.effort } : {},
  }))
}

/**
 * Same as {@link toReviewerSpecs}, but zero valid rows is a hard failure.
 * @param rows - stored table.
 * @throws {@link EMPTY_REVIEWERS_MESSAGE} when nothing is configured.
 */
export function requireConfiguredReviewers(rows: readonly ReviewerSettingsRow[]): ReviewerSpec[] {
  const specs = toReviewerSpecs(rows)
  if (specs.length === 0) throw new Error(EMPTY_REVIEWERS_MESSAGE)
  return specs
}

/**
 * Coerce one stored or mirrored reviewer value into a settings row.
 * Unknown keys are dropped. Missing strings become empty provider/model.
 * @param value - one array element from the settings section.
 */
export function parseReviewerRow(value: unknown): ReviewerSettingsRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { provider: '', model: '' }
  }
  const record = value as Record<string, unknown>
  return {
    provider: typeof record.provider === 'string' ? record.provider : '',
    model: typeof record.model === 'string' ? record.model : '',
    ...typeof record.effort === 'string' ? { effort: record.effort } : {},
    ...typeof record.role === 'string' ? { role: record.role } : {},
  }
}

/**
 * Read the stored perspective off a settings section.
 *
 * The blank-means-default rule lives in `prompts.ts`, so this returns the
 * stored text unchanged, including whitespace-only text.
 * @param section - `ctx.reviewSettings.current()` value, or any object with the same fields.
 * @returns the stored text, or `''` when the section has none.
 */
export function perspectiveFromSection(section: unknown): string {
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return ''
  const value = (section as { perspective?: unknown }).perspective
  return typeof value === 'string' ? value : ''
}

/**
 * Read the reviewers array off a settings section. Absent or non-array is empty.
 * @param section - `ctx.reviewSettings.current()` value, or any object with the same fields.
 */
export function reviewersFromSection(section: unknown): ReviewerSettingsRow[] {
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return []
  const reviewers = (section as { reviewers?: unknown }).reviewers
  if (!Array.isArray(reviewers)) return []
  return reviewers.map(parseReviewerRow)
}
