/**
 * Reviewer-model configuration dialog. Confirm writes settings; cancel does not.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { MAX_REVIEWERS, type ReviewerSettingsRow } from '@psychiiii/dsh-three-window-review/reviewers'
import type { ReviewCatalogGroup, ReviewCatalogState, ReviewSettingsState } from './settings-store.ts'
import css from './ReviewDock.module.css'

/** One editable row in the dialog. Empty strings mean unused. */
export interface ReviewerDraftRow {
  provider: string
  model: string
  effort: string
}

const EMPTY_DRAFT_ROW: ReviewerDraftRow = { provider: '', model: '', effort: '' }

/**
 * @param rows - stored settings rows.
 * @returns a draft of 1–5 rows, padded with one empty row when none are stored.
 */
export function draftFromSettings(rows: readonly ReviewerSettingsRow[]): ReviewerDraftRow[] {
  const draft = rows.map(row => ({
    provider: row.provider,
    model: row.model,
    effort: row.effort ?? '',
  }))
  if (draft.length === 0) return [{ ...EMPTY_DRAFT_ROW }]
  return draft.slice(0, MAX_REVIEWERS)
}

/**
 * Drop unused slots. Incomplete rows stay so confirm can reject them.
 * @param draft - dialog rows.
 */
export function settingsFromDraft(draft: readonly ReviewerDraftRow[]): ReviewerSettingsRow[] {
  return draft.map(row => ({
    provider: row.provider.trim(),
    model: row.model.trim(),
    ...row.effort.trim().length > 0 ? { effort: row.effort.trim() } : {},
  }))
}

function groupOf(
  groups: readonly ReviewCatalogGroup[],
  provider: string,
): ReviewCatalogGroup | undefined {
  return groups.find(group => group.id === provider)
}

function modelOf(
  group: ReviewCatalogGroup | undefined,
  model: string,
): ReviewCatalogGroup['models'][number] | undefined {
  return group?.models.find(item => item.id === model)
}

/**
 * Reviewer configuration dialog.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - cancel / mask / Escape; does not write.
 * @param props.settings - current settings snapshot.
 * @param props.catalog - current catalog snapshot.
 * @param props.onConfirm - persist the draft; true closes the dialog.
 * @param props.t - locale.
 */
export function ReviewerModal({
  open, onClose, settings, catalog, onConfirm, t,
}: {
  open: boolean
  onClose: () => void
  settings: ReviewSettingsState
  catalog: ReviewCatalogState
  onConfirm: (rows: readonly ReviewerSettingsRow[], expectedRevision: number) => Promise<boolean>
  t: TranslateNS<'personalReview'>
}): ReactNode {
  const [draft, setDraft] = useState<ReviewerDraftRow[]>(() => draftFromSettings(settings.reviewers))
  const [revision] = useState(settings.revision)
  const [busy, setBusy] = useState(false)

  const groups = catalog.groups
  const saving = busy || settings.status === 'saving'

  const setRow = (index: number, patch: Partial<ReviewerDraftRow>): void => {
    setDraft((current) => current.map((row, rowIndex) => {
      if (rowIndex !== index) return row
      const next = { ...row, ...patch }
      if (patch.provider !== undefined && patch.provider !== row.provider) {
        next.model = ''
        next.effort = ''
      }
      if (patch.model !== undefined && patch.model !== row.model) {
        const group = groupOf(groups, next.provider)
        const model = modelOf(group, next.model)
        next.effort = model?.reasoning?.defaultEffort ?? ''
      }
      return next
    }))
  }

  const addRow = (): void => {
    if (draft.length >= MAX_REVIEWERS) return
    setDraft(current => [...current, { ...EMPTY_DRAFT_ROW }])
  }

  const removeRow = (index: number): void => {
    setDraft(current => current.filter((_, rowIndex) => rowIndex !== index))
  }

  const confirm = async (): Promise<void> => {
    if (saving) return
    setBusy(true)
    try {
      const ok = await onConfirm(settingsFromDraft(draft), revision)
      if (ok) onClose()
    } finally {
      setBusy(false)
    }
  }

  const effortOptions = useMemo(() => {
    return draft.map((row) => {
      const model = modelOf(groupOf(groups, row.provider), row.model)
      return model?.reasoning?.efforts ?? []
    })
  }, [draft, groups])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('modal.title')}
      closeLabel={t('modal.close')}
      description={t('modal.description')}
      footer={(
        <div className={css.footer}>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            {t('modal.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => { void confirm() }} disabled={saving || !settings.writable}>
            {saving ? t('modal.saving') : t('modal.confirm')}
          </Button>
        </div>
      )}
    >
      <div className={css.modalBody} data-personal-review-modal="">
        {settings.error !== null && (
          <div className={css.error} role="alert" data-personal-review-error="">
            {settings.errorDetail?.kind === 'effort'
              ? t('modal.effort.invalid', {
                provider: settings.errorDetail.provider,
                model: settings.errorDetail.model,
                effort: settings.errorDetail.effort,
                known: settings.errorDetail.known.join('、'),
              })
              : settings.error}
          </div>
        )}
        {catalog.status === 'error' && catalog.error !== null && (
          <div className={css.error} role="alert">{catalog.error}</div>
        )}
        {catalog.status === 'ready' && groups.length === 0 && (
          <div className={css.meta}>{t('modal.catalog.empty')}</div>
        )}
        {draft.map((row, index) => {
          const group = groupOf(groups, row.provider)
          const efforts = effortOptions[index] ?? []
          return (
            <div key={index} className={css.rowBlock} data-reviewer-row={String(index)}>
              <div className={css.formRow}>
                <label className={css.field}>
                  <span>{t('modal.provider')}</span>
                  <select
                    data-reviewer-provider=""
                    aria-label={t('modal.provider')}
                    value={row.provider}
                    onChange={event => { setRow(index, { provider: event.target.value }) }}
                  >
                    <option value="">{t('modal.provider.empty')}</option>
                    {groups.map(item => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </label>
                <label className={css.field}>
                  <span>{t('modal.model')}</span>
                  <select
                    data-reviewer-model=""
                    aria-label={t('modal.model')}
                    value={row.model}
                    disabled={group === undefined}
                    onChange={event => { setRow(index, { model: event.target.value }) }}
                  >
                    <option value="">{t('modal.model.empty')}</option>
                    {(group?.models ?? []).map(item => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </label>
                <label className={css.field}>
                  <span>{t('modal.effort')}</span>
                  <select
                    data-reviewer-effort=""
                    aria-label={t('modal.effort')}
                    value={row.effort}
                    disabled={efforts.length === 0}
                    onChange={event => { setRow(index, { effort: event.target.value }) }}
                  >
                    <option value="">{t('modal.effort.none')}</option>
                    {efforts.map(item => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  data-reviewer-remove=""
                  onClick={() => { removeRow(index) }}
                >
                  {t('modal.remove')}
                </Button>
              </div>
            </div>
          )
        })}
        <Button
          variant="outline"
          size="sm"
          data-reviewer-add=""
          disabled={draft.length >= MAX_REVIEWERS}
          onClick={addRow}
        >
          {t('modal.add')}
        </Button>
      </div>
    </Modal>
  )
}
