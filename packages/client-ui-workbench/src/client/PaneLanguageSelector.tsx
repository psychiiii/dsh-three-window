/**
 * Pane header control: 「输出语言：zh-CN（简体中文）」, opening the fixed language
 * list. It edits the same setting as the Settings → General rows.
 */
import { useState, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaneLanguagesView } from './pane-language.ts'
import css from './WorkbenchPanel.module.css'

/** Menu id standing for "not specified"; the stored value is blank. */
const UNSPECIFIED_ID = 'unspecified'

/** Props of {@link PaneLanguageSelector}. */
export interface PaneLanguageSelectorProps {
  /** Left-to-right pane index. */
  index: number
  /** The pane headers' view. */
  view: PaneLanguagesView
  /** Store the pane's language. */
  save: (index: number, tag: string) => Promise<boolean>
  /** Workbench translator. */
  t: (key: 'language.label' | 'language.unspecified' | 'language.aria', params?: Record<string, string>) => string
}

/**
 * @param props - pane index, view, save action, translator.
 * @returns the control, or nothing when the pane has no window or no settings service.
 */
export function PaneLanguageSelector({ index, view, save, t }: PaneLanguageSelectorProps): ReactNode {
  const [open, setOpen] = useState(false)
  const value = view.values[index]
  if (!view.available || value === undefined) return null
  const name = view.labelFor(value) ?? t('language.unspecified')
  const editable = view.ready && view.writable && !view.saving
  const items = [
    { id: UNSPECIFIED_ID, label: t('language.unspecified') },
    ...view.options.map(option => ({ id: option.tag, label: option.label })),
  ]
  // Menu wraps its anchor, so the right-alignment rides a wrapper of ours.
  return (
    <span className={css.languageSlot}>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={items}
        selectedId={value === '' ? UNSPECIFIED_ID : value}
        onSelect={(id) => {
          setOpen(false)
          void save(index, id === UNSPECIFIED_ID ? '' : id)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.language}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={t('language.aria')}
            disabled={!editable}
            data-workbench-language={String(index)}
            data-workbench-language-value={value === '' ? UNSPECIFIED_ID : value}
            onClick={(event) => {
              // The pane itself takes clicks to focus its window.
              event.stopPropagation()
              setOpen(v => !v)
            }}
          >
            {t('language.label', { name })}
            <IconChevronDownOutlineRegular className={css.languageChevron} />
          </button>
        )}
      />
    </span>
  )
}
