/**
 * Review dock (review window only): the reviewer-model and review-guidance
 * buttons, and the latest review run — its progress, how it ended, and the
 * original report in a dialog (`ReviewRunPanel.tsx`). The conclusion is only
 * in the conversation. The list a review runs on is confirmed in dsh's own
 * question dialog, which `review_debate` raises itself.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { REVIEW_PRESET, type ReviewerSettingsRow } from '@psychiiii/dsh-three-window-review/reviewers'
import type { ReviewPanelState } from '@psychiiii/dsh-three-window-review/types'
import { reviewGuidanceEntryFor } from '@psychiiii/dsh-three-window-review/review-guidance'
import { GuidanceModal } from './GuidanceModal.tsx'
import { ReviewerModal } from './ReviewerModal.tsx'
import { ReviewRunPanel } from './ReviewRunPanel.tsx'
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
  /** Persist one Workspace's standing review guidance; blank removes it. */
  saveGuidance: (root: string, text: string) => Promise<boolean>
  /** Hold or release the review window's composer lock (see composer-lock.ts). */
  lockComposer: (sessionId: string, locked: boolean, reason: string) => void
}

export type ReviewDockProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'personalReview'>
  & InjectFace<ReviewDockInjected>

/**
 * Review-window dock: configuration button, configured reviewers, latest debate report.
 * @param props - session dock runtime, locale, and settings face.
 */
export function ReviewDock({
  sessionId, useSessions, useProjection, useReviewSettings, useReviewCatalog,
  loadSettings, loadCatalog, saveSettings, saveGuidance, lockComposer, t,
}: ReviewDockProps): ReactNode {
  const preset = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  })
  const isReview = preset === REVIEW_PRESET
  const cwd = useSessions((state) => {
    const value = (state.byId[sessionId] as { cwd?: unknown } | undefined)?.cwd
    return typeof value === 'string' ? value : undefined
  })
  const panel = useProjection('personalReview') as ReviewPanelState | null | undefined
  const [guidanceOpen, setGuidanceOpen] = useState(false)
  const [guidanceKey, setGuidanceKey] = useState(0)
  const settings = useReviewSettings(snapshot => snapshot)
  const catalog = useReviewCatalog(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [modalKey, setModalKey] = useState(0)

  useEffect(() => {
    if (!isReview) return
    void loadSettings()
    void loadCatalog()
  }, [isReview, loadSettings, loadCatalog])

  const configured = settings.reviewers.filter(row => row.provider.length > 0 && row.model.length > 0)
  // Locked only once the settings are known to hold no reviewer: while they are
  // loading, or when they cannot be read, the window stays usable, so a
  // settings failure can never lock it for good.
  const needsReviewers = isReview && settings.status === 'ready' && configured.length === 0
  const lockReason = t('lock.reason')
  useEffect(() => {
    lockComposer(sessionId, needsReviewers, lockReason)
  }, [lockComposer, sessionId, needsReviewers, lockReason])
  useEffect(() => () => { lockComposer(sessionId, false, '') }, [lockComposer, sessionId])

  if (!isReview) return null
  const own = reviewGuidanceEntryFor(settings.reviewGuidance, cwd)
  const fallback = settings.perspective.trim()
  const guidanceSource = own !== undefined ? 'workspace' : fallback.length > 0 ? 'default' : 'none'
  const guidanceText = own?.text.trim() ?? fallback

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
        <span className={css.headerActions}>
        <Button
          variant="outline"
          size="sm"
          data-review-guidance-button=""
          disabled={cwd === undefined}
          onClick={() => {
            void loadSettings()
            setGuidanceKey(key => key + 1)
            setGuidanceOpen(true)
          }}
        >
          {t('guidance.button')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={needsReviewers ? css.needsConfig : undefined}
          data-personal-review-config=""
          data-personal-review-needs-config={needsReviewers ? 'true' : undefined}
          onClick={openModal}
        >
          {t('config.button')}
        </Button>
        </span>
      </div>
      <div className={css.meta} data-review-guidance={guidanceSource} title={guidanceText}>
        {guidanceSource === 'none'
          ? t('guidance.summary.none')
          : t(guidanceSource === 'workspace' ? 'guidance.summary.workspace' : 'guidance.summary.default', {
            text: guidanceText.length > 60 ? `${guidanceText.slice(0, 60)}…` : guidanceText,
          })}
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
      {panel !== undefined && panel !== null && <ReviewRunPanel panel={panel} t={t} />}
      {guidanceOpen && cwd !== undefined && (
        <GuidanceModal
          key={guidanceKey}
          open={guidanceOpen}
          onClose={() => { setGuidanceOpen(false) }}
          initial={own?.text ?? ''}
          fallback={fallback}
          writable={settings.writable}
          onSave={text => saveGuidance(cwd, text)}
          t={t}
        />
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
