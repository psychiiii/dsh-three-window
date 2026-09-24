/**
 * Global reviewer-settings controller: the `personal-settings` entry's config
 * form (values and writes) plus the model catalog.
 * @module @psychiiii/dsh-three-window-review/client/settings-store
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  assertReviewerTable, parseReviewerRow, perspectiveFromSection,
  toReviewerSpecs, type ReviewSettings, type ReviewerSettingsRow,
} from '@psychiiii/dsh-three-window-review/reviewers'
import {
  ReviewerResolutionError, resolveReviewerModels,
  type ReviewerCatalog, type ReviewerResolutionDetail,
} from '@psychiiii/dsh-three-window-review/resolve'

/** One provider group the modal can offer. */
export interface ReviewCatalogGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ReviewCatalogModel[]
}

/** One model inside a loaded provider group. */
export interface ReviewCatalogModel {
  readonly id: string
  readonly name: string
  readonly reasoning?: {
    readonly efforts: readonly { readonly id: string; readonly name: string }[]
    readonly defaultEffort?: string
  }
}

/** Settings snapshot the dock, the modal, and the settings page render from. */
export interface ReviewSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'unavailable' | 'error'
  error: string | null
  writable: boolean
  revision: number
  reviewers: readonly ReviewerSettingsRow[]
  /** Stored perspective text, verbatim; blank means the built-in default. */
  perspective: string
  /**
   * The catalog refusal behind `error`, when the refusal came from
   * {@link resolveReviewerModels}. The dialog renders its own copy from these
   * fields; `error` stays the English text for anything that only shows a
   * string.
   */
  errorDetail: ReviewerResolutionDetail | null
}

/** Host model catalog snapshot. */
export interface ReviewCatalogState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  groups: readonly ReviewCatalogGroup[]
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

function rowsFromValue(value: unknown): ReviewerSettingsRow[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const reviewers = (value as { reviewers?: unknown }).reviewers
  if (!Array.isArray(reviewers)) return []
  return reviewers.map(parseReviewerRow)
}

function groupsFromCatalog(value: unknown): ReviewCatalogGroup[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const groups = (value as { groups?: unknown }).groups
  if (!Array.isArray(groups)) return []
  const next: ReviewCatalogGroup[] = []
  for (const group of groups) {
    if (group === null || typeof group !== 'object' || Array.isArray(group)) continue
    const record = group as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.name !== 'string') continue
    if (!Array.isArray(record.models) || record.models.length === 0) continue
    const models: ReviewCatalogModel[] = []
    for (const model of record.models) {
      if (model === null || typeof model !== 'object' || Array.isArray(model)) continue
      const entry = model as Record<string, unknown>
      if (typeof entry.id !== 'string' || typeof entry.name !== 'string') continue
      const reasoningRaw = entry.reasoning
      let reasoning: ReviewCatalogModel['reasoning']
      if (reasoningRaw !== null && typeof reasoningRaw === 'object' && !Array.isArray(reasoningRaw)) {
        const reasoningRecord = reasoningRaw as Record<string, unknown>
        const effortsRaw = reasoningRecord.efforts
        const efforts: { id: string; name: string }[] = []
        if (Array.isArray(effortsRaw)) {
          for (const effort of effortsRaw) {
            if (effort === null || typeof effort !== 'object' || Array.isArray(effort)) continue
            const item = effort as Record<string, unknown>
            if (typeof item.id === 'string' && typeof item.name === 'string') {
              efforts.push({ id: item.id, name: item.name })
            }
          }
        }
        if (efforts.length > 0) {
          reasoning = {
            efforts,
            ...typeof reasoningRecord.defaultEffort === 'string'
              ? { defaultEffort: reasoningRecord.defaultEffort }
              : {},
          }
        }
      }
      models.push({
        id: entry.id,
        name: entry.name,
        ...reasoning !== undefined ? { reasoning } : {},
      })
    }
    if (models.length > 0) next.push({ id: record.id, name: record.name, models })
  }
  return next
}

/** Follows the `personal-settings` entry's config form and writes through it. */
export class ReviewSettingsController {
  /** Settings snapshot. */
  readonly store: SnapshotStore<ReviewSettingsState> = createSnapshotStore({
    status: 'idle',
    error: null,
    writable: false,
    revision: 0,
    reviewers: [],
    perspective: '',
    errorDetail: null,
  })

  /** Host catalog snapshot. */
  readonly catalog: SnapshotStore<ReviewCatalogState> = createSnapshotStore({
    status: 'idle',
    error: null,
    groups: [],
  })

  private following: (() => void) | undefined
  private saving = false
  private disposed = false

  /**
   * @param form - the `personal-settings` entry's config form (`configForms.get`).
   * @param ctx - plugin context with `remote.session`.
   */
  constructor(
    private readonly form: ConfigForm<ReviewSettings>,
    private readonly ctx: ClientContext,
  ) {}

  /**
   * Follow the form. The form loads itself once created; this reflects its
   * current snapshot and every later one.
   * @returns settlement once the snapshot reflects the form.
   */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.following ??= this.form.subscribe(() => { this.derive() })
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
      state.errorDetail = null
    })
    this.derive()
    return Promise.resolve()
  }

  /**
   * Load the Host-generation model catalog (providers that listed models).
   * @returns settlement of the catalog snapshot.
   */
  async loadCatalog(): Promise<void> {
    if (this.disposed) return
    this.catalog.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    try {
      const response = await this.ctx.remote.session.modelCatalog()
      if (this.disposed) return
      if (!response.ok) {
        this.catalog.set({
          status: 'error',
          error: `${response.error.code}: ${response.error.message}`,
          groups: this.catalog.getSnapshot().groups,
        })
        return
      }
      this.catalog.set({
        status: 'ready',
        error: null,
        groups: groupsFromCatalog(response.value),
      })
    } catch (error) {
      if (this.disposed) return
      this.catalog.set({
        status: 'error',
        error: errorText(error),
        groups: this.catalog.getSnapshot().groups,
      })
    }
  }

  /**
   * Persist the reviewer table. Keeps the previous snapshot on failure so the
   * modal can stay open with the draft the caller still holds.
   * @param rows - 0–5 rows; incomplete rows are rejected.
   * @param expectedRevision - describe revision the dialog was filled from;
   *   omit to use the latest store revision.
   */
  async save(rows: readonly ReviewerSettingsRow[], expectedRevision?: number): Promise<boolean> {
    const state = this.store.getSnapshot()
    let normalized: ReviewerSettingsRow[]
    try {
      normalized = assertReviewerTable(rows)
    } catch (error) {
      this.reportError(error)
      return false
    }
    try {
      await resolveReviewerModels(this.disclosedRoutes(normalized), this.catalogFace())
    } catch (error) {
      this.reportError(error)
      return false
    }
    return this.commit(
      { reviewers: normalized, perspective: state.perspective },
      [{ op: 'set', path: ['reviewers'], value: normalized as never }],
      expectedRevision,
    )
  }

  /**
   * Persist the review perspective. Text is stored exactly as typed; blank
   * text is stored blank and the seats then receive the built-in default.
   * @param perspective - the field's text, untrimmed.
   * @param expectedRevision - describe revision the editor was filled from;
   *   omit to use the latest store revision.
   * @returns whether the write landed.
   */
  async savePerspective(perspective: string, expectedRevision?: number): Promise<boolean> {
    const state = this.store.getSnapshot()
    return this.commit(
      { reviewers: state.reviewers, perspective },
      [{ op: 'set', path: ['perspective'], value: perspective as never }],
      expectedRevision,
    )
  }

  private reportError(error: unknown): void {
    this.store.update((draft) => {
      draft.status = 'error'
      draft.error = errorText(error)
      draft.errorDetail = error instanceof ReviewerResolutionError ? error.detail : null
    })
  }

  /**
   * The loaded catalog as the lookup {@link resolveReviewerModels} expects, so
   * the settings page and `review_debate` refuse the same rows for the same
   * reasons. Only rows {@link disclosedRoutes} kept ever reach it, so
   * `listModels` is never asked about a provider the catalog does not carry.
   * @returns the lookup over the current catalog snapshot.
   */
  private catalogFace(): ReviewerCatalog {
    const groups = this.catalog.getSnapshot().groups
    const model = (provider: string, id: string): ReviewCatalogModel | undefined =>
      groups.find(group => group.id === provider)?.models.find(item => item.id === id)
    return {
      listModels: (provider) => {
        const group = groups.find(item => item.id === provider)
        return Promise.resolve((group?.models ?? []).map(item => ({ id: item.id })))
      },
      listEfforts: (provider, id) => Promise.resolve(model(provider, id)?.reasoning?.efforts.map(item => item.id)),
    }
  }

  /**
   * The rows the loaded catalog can actually speak to.
   *
   * A row naming a provider or model this browser's catalog does not carry is
   * not thereby wrong — the catalog lists only providers that answered, and a
   * stored table outlives any one of them. Refusing such a row at save time
   * would strand a user who can no longer edit their own settings, so the save
   * check stays where the catalog has evidence: routes it disclosed.
   * @param rows - the normalized table about to be written.
   * @returns specs for the rows the catalog disclosed.
   */
  private disclosedRoutes(rows: readonly ReviewerSettingsRow[]): ReturnType<typeof toReviewerSpecs> {
    const groups = this.catalog.getSnapshot().groups
    return toReviewerSpecs(rows).filter(spec =>
      groups.find(group => group.id === spec.provider)?.models.some(item => item.id === spec.model) === true)
  }

  /**
   * Write one patch against the revision the editor was filled from. The Host
   * validates it against the row's Config, including the reviewer-table checks.
   * @param value - the section as it will read after the patch.
   * @param ops - the patch itself.
   * @param expectedRevision - revision for the compare-and-set.
   * @returns whether the write landed.
   */
  private async commit(
    value: { reviewers: readonly ReviewerSettingsRow[]; perspective: string },
    ops: readonly { op: 'set'; path: string[]; value: never }[],
    expectedRevision: number | undefined,
  ): Promise<boolean> {
    const state = this.store.getSnapshot()
    if (!state.writable || this.saving) return false
    const revision = expectedRevision ?? state.revision
    this.saving = true
    this.store.update((draft) => {
      draft.status = 'saving'
      draft.error = null
      draft.errorDetail = null
    })
    let accepted: boolean
    try {
      accepted = await this.form.mutate([...ops], revision)
    } catch (error) {
      this.saving = false
      this.reportError(error)
      return false
    }
    this.saving = false
    if (this.disposed) return false
    if (!accepted) {
      // The form reports refusal without a reason (stale revision or a value
      // the Host's Config validation rejected) and reloads the stored values.
      const fields = ops.map(op => op.path.join('.')).join(', ')
      this.reportError(new Error(`the Host refused the change to ${fields}; the stored values were reloaded`))
      return false
    }
    this.derive()
    return true
  }

  /** Stop following the mirror. */
  dispose(): void {
    this.disposed = true
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    if (this.disposed || this.saving) return
    const snapshot = this.form.getSnapshot()
    if (snapshot.status === 'unavailable') {
      this.store.update((state) => {
        state.status = 'unavailable'
        state.writable = false
        state.reviewers = []
        state.perspective = ''
      })
      return
    }
    if (snapshot.status === 'loading' || snapshot.value === undefined) return
    const value = snapshot.value
    this.store.update((state) => {
      state.status = 'ready'
      state.error = null
      state.errorDetail = null
      state.writable = snapshot.writable
      state.revision = snapshot.revision ?? 0
      state.reviewers = rowsFromValue(value)
      state.perspective = perspectiveFromSection(value)
    })
  }
}
