/**
 * First-entry prompt for the model output language.
 *
 * Mounted through the composer dock of the construct window's Session, which
 * exists exactly once in the three-window layout, so the dialog opens once.
 * It opens only when the settings are known — read, writable, and the prompt
 * not yet answered — so a settings failure can never make it nag. Saving or
 * choosing "later" both record the answer; afterwards the General rows are
 * the only editor.
 *
 * Only those two buttons record anything. Closing the dialog any other way —
 * Escape, the close button, or a click outside it — hides it for this page
 * load only: on a fresh home dsh opens its own first-run dialogs at the same
 * moment, and a click meant for one of them lands outside this one, which
 * must not count as the user's answer. For the same reason the dialog waits
 * while any other dialog is open and appears once they have all closed, so it
 * never stacks on top of dsh's own.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  OUTPUT_LANGUAGE_PRESETS, OUTPUT_LANGUAGE_WINDOWS, type OutputLanguageSettings,
} from '@psychiiii/dsh-three-window-review/output-language'
import { OutputLanguageSelector, outputLanguageWindowName } from './OutputLanguageRow.tsx'
import type { ReviewSettingsState } from './settings-store.ts'
import css from './OutputLanguageRow.module.css'

/** Whether the document holds an open dialog, modal or not. */
function otherDialogOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]') !== null
}

/**
 * Whether no other dialog is open, following the document while waiting.
 * @param watching - whether to follow at all; false once this prompt shows.
 * @returns true when the page holds no dialog.
 */
function useNoOtherDialog(watching: boolean): boolean {
  const [clear, setClear] = useState(() => !otherDialogOpen())
  useEffect(() => {
    if (!watching) return
    const update = (): void => { setClear(!otherDialogOpen()) }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal'] })
    return () => { observer.disconnect() }
  }, [watching])
  return clear
}

/** Registration-side face of the prompt. */
export interface OutputLanguagePromptInjected {
  hooks: {
    /** Settings snapshot shared with the review surfaces. */
    reviewSettings: SnapshotStore<ReviewSettingsState>
  }
  /** Start following the settings form. */
  loadSettings: () => Promise<void>
  /** Store the choices, or only mark the prompt answered when given null. */
  answerOutputLanguagePrompt: (languages: OutputLanguageSettings | null) => Promise<boolean>
}

export type OutputLanguagePromptProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'personalReview'>
  & InjectFace<OutputLanguagePromptInjected>

/**
 * The prompt, rendered only in the construct window's dock.
 * @param props - dock runtime, locale, and settings face.
 * @returns the dialog while it is due, otherwise nothing.
 */
export function OutputLanguagePrompt({
  sessionId, useSessions, useReviewSettings, loadSettings, answerOutputLanguagePrompt, t,
}: OutputLanguagePromptProps): ReactNode {
  const preset = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  })
  const isConstruct = preset === OUTPUT_LANGUAGE_PRESETS.construct
  const settings = useReviewSettings(snapshot => snapshot)
  const [draft, setDraft] = useState<OutputLanguageSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    if (isConstruct) void loadSettings()
  }, [isConstruct, loadSettings])

  const due = isConstruct && settings.status === 'ready' && settings.writable && !settings.outputLanguagePrompted
  const [shown, setShown] = useState(false)
  const clear = useNoOtherDialog(due && !hidden && !shown)
  const visible = !hidden && (busy || (due && (shown || clear)))
  useEffect(() => {
    if (visible && !shown) setShown(true)
  }, [visible, shown])
  if (!visible) return null
  const current = draft ?? settings.outputLanguage

  const answer = async (languages: OutputLanguageSettings | null): Promise<void> => {
    setBusy(true)
    try {
      await answerOutputLanguagePrompt(languages)
    } finally {
      setBusy(false)
      setDraft(null)
    }
  }

  return (
    <Modal
      open
      onClose={() => { if (!busy) setHidden(true) }}
      title={t('language.prompt.title')}
      closeLabel={t('language.prompt.close')}
      description={t('language.prompt.description')}
      footer={(
        <div className={css.footer}>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            data-output-language-prompt-later=""
            onClick={() => { void answer(null) }}
          >
            {t('language.prompt.later')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            data-output-language-prompt-save=""
            onClick={() => { void answer(current) }}
          >
            {t('language.prompt.save')}
          </Button>
        </div>
      )}
    >
      <div className={css.promptList} data-output-language-prompt="">
        {settings.error !== null && (
          <div className={css.error} role="alert">{settings.error}</div>
        )}
        {OUTPUT_LANGUAGE_WINDOWS.map(window => (
          <div key={window} className={css.promptRow}>
            <span>{outputLanguageWindowName(t, window)}</span>
            <OutputLanguageSelector
              value={current[window]}
              onChange={(tag) => { setDraft({ ...current, [window]: tag }) }}
              disabled={busy}
              t={t}
              testId={`prompt-${window}`}
            />
          </div>
        ))}
      </div>
    </Modal>
  )
}
