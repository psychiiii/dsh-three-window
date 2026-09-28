/**
 * Edit one Workspace's standing review guidance from its review window: what
 * every review in that Workspace should weigh. Blank removes it, and the
 * Workspace falls back to the default set on the settings page.
 */
import { useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { REVIEW_GUIDANCE_MAX } from '@psychiiii/dsh-three-window-review/review-guidance'
import css from './ReviewDock.module.css'

/** Props of {@link GuidanceModal}. */
export interface GuidanceModalProps {
  open: boolean
  onClose: () => void
  /** The Workspace's own guidance, or blank when it has none. */
  initial: string
  /** The default guidance, shown so the user knows what blank falls back to. */
  fallback: string
  /** Whether settings can be written from this page. */
  writable: boolean
  /** Persist; resolves to whether the write landed. */
  onSave: (text: string) => Promise<boolean>
  t: TranslateNS<'personalReview'>
}

/**
 * @param props - the Workspace's current text, its fallback, and the save action.
 * @returns the dialog.
 */
export function GuidanceModal({ open, onClose, initial, fallback, writable, onSave, t }: GuidanceModalProps): ReactNode {
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const over = draft.length > REVIEW_GUIDANCE_MAX
  const save = async (text: string): Promise<void> => {
    setSaving(true)
    setFailed(false)
    const ok = await onSave(text)
    setSaving(false)
    if (ok) onClose()
    else setFailed(true)
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('guidance.title')}
      closeLabel={t('modal.close')}
      description={t('guidance.description')}
      footer={(
        <div className={css.footer}>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>{t('modal.cancel')}</Button>
          <Button
            variant="outline"
            size="sm"
            data-review-guidance-clear=""
            disabled={!writable || saving || initial.length === 0}
            onClick={() => { void save('') }}
          >
            {t('guidance.clear')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            data-review-guidance-save=""
            disabled={!writable || saving || over}
            onClick={() => { void save(draft) }}
          >
            {t('guidance.save')}
          </Button>
        </div>
      )}
    >
      <div className={css.modalBody}>
        <textarea
          className={css.guidanceInput}
          data-review-guidance-input=""
          value={draft}
          placeholder={t('guidance.placeholder')}
          disabled={!writable}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <div className={over ? css.error : css.meta} data-review-guidance-count="" data-review-guidance-over={over ? 'true' : undefined}>
          {t('guidance.count', { n: String(draft.length), max: String(REVIEW_GUIDANCE_MAX) })}
        </div>
        <div className={css.meta} data-review-guidance-fallback="">
          {fallback.trim().length === 0 ? t('guidance.fallback.none') : t('guidance.fallback', { text: fallback.trim() })}
        </div>
        {!writable && <div className={css.error}>{t('guidance.readonly')}</div>}
        {failed && <div className={css.error} data-review-guidance-error="">{t('guidance.error')}</div>}
      </div>
    </Modal>
  )
}
