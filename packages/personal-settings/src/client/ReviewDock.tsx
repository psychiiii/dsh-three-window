/**
 * Review dock: reviewer-model button (review window only) plus the latest debate report.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { REVIEW_PRESET, type ReviewerSettingsRow } from '@psychiiii/dsh-three-window-review/reviewers'
import type { DebateReport, TerminalState } from '@psychiiii/dsh-three-window-review/types'
import { ReviewerModal } from './ReviewerModal.tsx'
import type { ReviewCatalogState, ReviewSettingsState } from './settings-store.ts'
import css from './ReviewDock.module.css'

/** Registration-side face: global settings + catalog. */
export interface ReviewDockInjected {
  hooks: {
    /** Reviewer settings snapshot. */
    reviewSettings: SnapshotStore<ReviewSettingsState>
    /** Host model catalog snapshot. */
    reviewCatalog: SnapshotStore<ReviewCatalogState>
  }
  /** Load the settings namespace. */
  loadSettings: () => Promise<void>
  /** Load the Host model catalog. */
  loadCatalog: () => Promise<void>
  /** Persist reviewer rows against the revision the dialog was filled from. */
  saveSettings: (rows: readonly ReviewerSettingsRow[], expectedRevision?: number) => Promise<boolean>
}

export type ReviewDockProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'personalReview'>
  & InjectFace<ReviewDockInjected>

const TERMINAL_KEYS: Record<TerminalState, 'terminal.incomplete_review' | 'terminal.blocked_by_missing_decision' | 'terminal.changes_proposed' | 'terminal.clear_within_scope'> = {
  incomplete_review: 'terminal.incomplete_review',
  blocked_by_missing_decision: 'terminal.blocked_by_missing_decision',
  changes_proposed: 'terminal.changes_proposed',
  clear_within_scope: 'terminal.clear_within_scope',
}

/**
 * Review-window dock: configuration button, configured reviewers, latest debate report.
 * @param props - session dock runtime, locale, and settings face.
 */
export function ReviewDock({
  sessionId, useSessions, useProjection, useReviewSettings, useReviewCatalog,
  loadSettings, loadCatalog, saveSettings, t,
}: ReviewDockProps): ReactNode {
  const preset = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  })
  const isReview = preset === REVIEW_PRESET
  const review = useProjection('personalReview') as DebateReport | null | undefined
  const settings = useReviewSettings(snapshot => snapshot)
  const catalog = useReviewCatalog(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [modalKey, setModalKey] = useState(0)

  useEffect(() => {
    if (!isReview) return
    void loadSettings()
    void loadCatalog()
  }, [isReview, loadSettings, loadCatalog])

  if (!isReview) return null

  const configured = settings.reviewers.filter(row => row.provider.length > 0 && row.model.length > 0)
  const openModal = (): void => {
    void loadSettings()
    void loadCatalog()
    setModalKey(key => key + 1)
    setOpen(true)
  }

  return (
    <section className={css.root} data-personal-review="" data-review-window="true">
      <div className={css.header}>
        <span>{t('title')}</span>
        <Button
          variant="outline"
          size="sm"
          data-personal-review-config=""
          onClick={openModal}
        >
          {t('config.button')}
        </Button>
      </div>
      {/* The window cannot write even after the session permission preset is
          raised, so the fence is stated where the user meets the window. */}
      <div className={css.meta} data-personal-review-readonly="">{t('readonly.notice')}</div>
      <div data-personal-review-config-list="">
        {configured.length === 0
          ? <div className={css.meta} data-personal-review-config-empty="">{t('config.empty')}</div>
          : (
            <ul className={css.list}>
              {configured.map((row, index) => {
                const role = row.role ?? `reviewer-${String(index + 1)}`
                const effort = row.effort !== undefined && row.effort.length > 0
                  ? t('config.effort', { effort: row.effort })
                  : ''
                return (
                  <li key={`${row.provider}/${row.model}/${String(index)}`} data-reviewer-configured="">
                    {t('config.row', {
                      role,
                      provider: row.provider,
                      model: row.model,
                      effort,
                    })}
                  </li>
                )
              })}
            </ul>
          )}
      </div>
      {review !== undefined && review !== null && (
        <div data-review-terminal={review.terminal}>
          <div className={css.header}>
            <span>{t('terminal', { terminal: t(TERMINAL_KEYS[review.terminal]) })}</span>
            <span className={css.meta}>{t('baseline', { id: review.baselineId })}</span>
          </div>
          <div className={css.meta} data-review-grouping={review.grouping}>
            {t('grouping', { grouping: review.grouping })}
          </div>
          <div
            className={css.meta}
            data-review-kind={review.reviewKind}
            data-review-stop={review.converged ? 'early' : 'round-cap'}
          >
            {review.reviewKind === 'single-model' ? t('reviewKind.single') : t('reviewKind.multi')}
            {' · '}
            {t('stop', { value: review.converged ? t('stop.early') : t('stop.cap') })}
          </div>
          <div data-review-audit="">
            <div>{t('audit')}</div>
            <ul className={css.list}>
              {review.seats.map(item => (
                <li key={item.seatId} data-review-audit-row={item.seatId}>
                  {t('audit.row', {
                    seat: item.seatId,
                    provider: item.provider,
                    model: item.model,
                    role: item.role,
                  })}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div>{t('findings')}</div>
            {review.findings.length === 0
              ? <div className={css.meta}>{t('empty.findings')}</div>
              : (
                <ul className={css.list}>
                  {review.findings.map(item => (
                    <li key={item.evidence}>
                      {item.severity} {item.evidence} ({t('seatCount', { n: String(item.seatCount) })})
                      <ul className={css.list}>
                        {item.claims.map(claim => (
                          <li key={claim.claim}>{claim.claim} ({t('seatCount', { n: String(claim.seats.length) })})</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
          </div>
          <div data-review-dissent="">
            <div>{t('dissent')}</div>
            {review.dissent.length === 0
              ? <div className={css.meta}>{t('empty.dissent')}</div>
              : (
                <ul className={css.list}>
                  {review.dissent.map(item => (
                    <li key={item.evidence}>
                      {item.severity} {item.evidence} ({t('seatCount', { n: String(item.seatCount) })})
                      <ul className={css.list}>
                        {item.claims.map(claim => (
                          <li key={claim.claim}>{claim.claim} ({t('seatCount', { n: String(claim.seats.length) })})</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
          </div>
          <div data-review-rounds="">
            <div>{t('rounds.title')}</div>
            <ul className={css.list}>
              {review.rounds.map(round => (
                <li key={round.round}>
                  {t('round', { n: String(round.round) })}
                  {': '}
                  {round.seats.map(seat => (
                    seat.ok
                      ? `${seat.seatId} ${t('kind.ok')}`
                      : `${seat.seatId} ${t('kind.fail')}`
                  )).join(', ')}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {open && (
        <ReviewerModal
          key={modalKey}
          open={open}
          onClose={() => { setOpen(false) }}
          settings={settings}
          catalog={catalog}
          onConfirm={saveSettings}
          t={t}
        />
      )}
    </section>
  )
}
