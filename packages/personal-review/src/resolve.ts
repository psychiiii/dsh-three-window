/**
 * Resolve configured reviewer provider/model/effort against the live LLM catalog.
 *
 * One entry point serves both planes: `review_debate` calls it at execute time
 * against `ctx.llm`, and the settings page calls it at save time against the
 * catalog the reviewer dialog already loaded. A second copy of these checks
 * would drift, so the failures carry {@link ReviewerResolutionDetail} and each
 * plane renders its own wording from those fields.
 * @module @psychiiii/dsh-three-window-review/resolve
 */

import type { ReviewerSpec } from './args.ts'

/** Catalog lookup used at `review_debate` execute time. */
export interface ReviewerCatalog {
  /** List models for one configured provider. */
  listModels(provider: string): Promise<readonly { readonly id: string }[]>
  /**
   * Optional effort ids for one exact route. `undefined` skips the effort check
   * (the catalog did not disclose efforts).
   */
  listEfforts?(provider: string, model: string): Promise<readonly string[] | undefined>
}

/**
 * Which check refused a reviewer row, and what the catalog offered instead.
 * `known` is empty when the catalog disclosed nothing.
 */
export type ReviewerResolutionDetail =
  | { readonly kind: 'provider'; readonly provider: string; readonly cause: string }
  | { readonly kind: 'model'; readonly provider: string; readonly model: string; readonly known: readonly string[] }
  | {
    readonly kind: 'effort'
    readonly provider: string
    readonly model: string
    readonly effort: string
    readonly known: readonly string[]
  }

/**
 * A reviewer row the catalog refused. The message is the operator-facing
 * English text; `detail` is the same refusal as fields, for a caller that
 * renders its own copy.
 */
export class ReviewerResolutionError extends Error {
  /**
   * @param message - the operator-facing text.
   * @param detail - the refusal as fields.
   */
  constructor(message: string, readonly detail: ReviewerResolutionDetail) {
    super(message)
    this.name = 'ReviewerResolutionError'
  }
}

/**
 * Fail the whole run when any reviewer row cannot be resolved. Known model
 * ids are included in the error.
 * @param specs - reviewers already taken from settings.
 * @param catalog - `ctx.llm.listModels` / `resolveModelInfo` adapters.
 * @throws {ReviewerResolutionError} on the first row the catalog refuses.
 */
export async function resolveReviewerModels(
  specs: readonly ReviewerSpec[],
  catalog: ReviewerCatalog,
): Promise<void> {
  for (const spec of specs) {
    let models: readonly { readonly id: string }[]
    try {
      models = await catalog.listModels(spec.provider)
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error)
      throw new ReviewerResolutionError(
        `review provider ${JSON.stringify(spec.provider)} cannot list models: ${cause}`,
        { kind: 'provider', provider: spec.provider, cause },
      )
    }
    const known = models.map(item => item.id)
    if (!known.includes(spec.model)) {
      throw new ReviewerResolutionError(
        `review model ${JSON.stringify(spec.model)} is not available on ${
          JSON.stringify(spec.provider)
        } (known: ${known.length === 0 ? '(none)' : known.join(', ')})`,
        { kind: 'model', provider: spec.provider, model: spec.model, known },
      )
    }
    if (spec.reasoningEffort === undefined || catalog.listEfforts === undefined) continue
    const efforts = await catalog.listEfforts(spec.provider, spec.model)
    if (efforts === undefined || efforts.length === 0) continue
    if (!efforts.includes(spec.reasoningEffort)) {
      throw new ReviewerResolutionError(
        `review effort ${JSON.stringify(spec.reasoningEffort)} is not available for ${
          spec.provider
        }/${spec.model} (known: ${efforts.join(', ')})`,
        { kind: 'effort', provider: spec.provider, model: spec.model, effort: spec.reasoningEffort, known: efforts },
      )
    }
  }
}
