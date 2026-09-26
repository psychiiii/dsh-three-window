/**
 * Model output language: one row per window in Settings → General, right
 * after dsh's own Language row, plus the selector the first-entry prompt
 * reuses. The interface language is dsh's; these rows set only what language
 * each window's model answers in.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  OUTPUT_LANGUAGES, OUTPUT_LANGUAGE_WINDOWS, UNSPECIFIED_OUTPUT_LANGUAGE, outputLanguageLabel, outputLanguageOf,
  type OutputLanguageWindow,
} from '@psychiiii/dsh-three-window-review/output-language'
import type { ReviewKey } from './locales.ts'
import type { ReviewSettingsState } from './settings-store.ts'
import css from './OutputLanguageRow.module.css'

/** Menu id standing for "not specified"; the stored value is blank. */
const UNSPECIFIED_ID = 'unspecified'

/** Translator over the `personalReview` namespace. */
type Translate = (key: ReviewKey, params?: Record<string, string>) => string

/**
 * The window's title in the current interface language.
 * @param t - translator.
 * @param window - the window.
 * @returns e.g. 「聊天窗」.
 */
export function outputLanguageWindowName(t: Translate, window: OutputLanguageWindow): string {
  return t(`language.window.${window}`)
}

/** Props of {@link OutputLanguageSelector}. */
export interface OutputLanguageSelectorProps {
  /** Stored value: a table tag or blank. */
  value: string
  /** Called with a table tag or blank. */
  onChange: (tag: string) => void
  /** Whether the selector can be opened. */
  disabled?: boolean
  /** Translator for the "not specified" label. */
  t: Translate
  /** Marker for drivers and tests. */
  testId: string
}

/**
 * Pill selector over the fixed language table.
 * @param props - value, change handler, and translator.
 * @returns the selector.
 */
export function OutputLanguageSelector({ value, onChange, disabled, t, testId }: OutputLanguageSelectorProps): ReactNode {
  const [open, setOpen] = useState(false)
  const selected = outputLanguageOf(value)
  const items = [
    { id: UNSPECIFIED_ID, label: t('language.unspecified') },
    ...OUTPUT_LANGUAGES.map(language => ({ id: language.tag, label: outputLanguageLabel(language) })),
  ]
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={items}
      selectedId={selected?.tag ?? UNSPECIFIED_ID}
      onSelect={(id) => {
        setOpen(false)
        onChange(id === UNSPECIFIED_ID ? UNSPECIFIED_OUTPUT_LANGUAGE : id)
      }}
      align="end"
      portal
      anchor={(
        <button
          type="button"
          className={css.selector}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          data-output-language-selector={testId}
          data-output-language-value={selected?.tag ?? UNSPECIFIED_ID}
          onClick={() => { setOpen(v => !v) }}
        >
          {selected === undefined ? t('language.unspecified') : outputLanguageLabel(selected)}
          <IconChevronDownOutlineRegular className={css.chevron} />
        </button>
      )}
    />
  )
}

/** Registration-side face of one General row. */
export interface OutputLanguageRowInjected {
  hooks: {
    /** Settings snapshot shared with the review surfaces. */
    reviewSettings: SnapshotStore<ReviewSettingsState>
  }
  /** The window this row sets. */
  window: OutputLanguageWindow
  /** Start following the settings form. */
  loadSettings: () => Promise<void>
  /** Persist this window's language. */
  saveOutputLanguage: (window: OutputLanguageWindow, tag: string) => Promise<boolean>
}

export type OutputLanguageRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'personalReview'>
  & InjectFace<OutputLanguageRowInjected>

/**
 * One window's output-language row.
 * @param props - composed slot props.
 * @returns the row.
 */
export function OutputLanguageRow({
  window, useReviewSettings, loadSettings, saveOutputLanguage, t,
}: OutputLanguageRowProps): ReactNode {
  const settings = useReviewSettings(snapshot => snapshot)
  useEffect(() => { void loadSettings() }, [loadSettings])
  const ready = settings.status === 'ready' || settings.status === 'saving' || settings.status === 'error'
  const editable = ready && settings.writable && settings.status !== 'saving'
  return (
    <div className={css.row} data-output-language-row={window}>
      <div className={css.rowText}>
        <div className={css.title}>
          {t('language.row.title', { window: outputLanguageWindowName(t, window) })}
        </div>
        {/* The three rows read as one group: the explanation sits under the
            first only, and a read-only page says so there too. */}
        {window === OUTPUT_LANGUAGE_WINDOWS[0] && (
          <div className={css.description}>
            {ready && !settings.writable ? t('language.row.readonly') : t('language.row.description')}
          </div>
        )}
      </div>
      <OutputLanguageSelector
        value={settings.outputLanguage[window]}
        onChange={(tag) => { void saveOutputLanguage(window, tag) }}
        disabled={!editable}
        t={t}
        testId={window}
      />
    </div>
  )
}
