/**
 * Browser service `outputLanguages`: each window's model output language, as
 * the workbench pane headers read and change it.
 *
 * The workbench (`client-ui-workbench`) owns the pane header and its selector;
 * this package owns the setting, which the Settings → General rows edit too, so
 * both always show the same value. The workbench reads the service with
 * `ctx.get('outputLanguages')` against a structural type of its own, so
 * neither package imports the other, and a composition without this package
 * simply shows no selector. It speaks in agent presets because a pane knows
 * the preset it runs, not this package's window keys.
 * @module @psychiiii/dsh-three-window-settings/client/output-languages
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  OUTPUT_LANGUAGES, UNSPECIFIED_OUTPUT_LANGUAGE, outputLanguageLabel, outputLanguageOf, outputLanguageWindowOf,
} from '@psychiiii/dsh-three-window-review/output-language'
import type { ReviewSettingsController, ReviewSettingsState } from './settings-store.ts'

/** One selectable language: the stored tag and its label, e.g. `zh-CN（简体中文）`. */
export interface OutputLanguageOption {
  readonly tag: string
  readonly label: string
}

/** What a pane header reads. */
export interface OutputLanguagesSnapshot {
  /** True once the stored values are known. */
  readonly ready: boolean
  /** Whether this page may write settings (loopback pages only). */
  readonly writable: boolean
  /** Whether a write is in flight. */
  readonly saving: boolean
  /** Every language, in menu order; "not specified" is the blank tag and is not listed. */
  readonly options: readonly OutputLanguageOption[]
  /**
   * @param preset - the pane's agent preset.
   * @returns its stored tag, blank for not specified, or undefined for a preset that is no window.
   */
  valueFor(preset: string): string | undefined
  /**
   * @param tag - a stored tag.
   * @returns its label, or undefined for blank or unknown.
   */
  labelFor(tag: string): string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Each window's output language; provided by the personal-settings browser half. */
    outputLanguages: OutputLanguagesService
  }
}

const OPTIONS: readonly OutputLanguageOption[] = Object.freeze(
  OUTPUT_LANGUAGES.map(language => ({ tag: language.tag, label: outputLanguageLabel(language) })),
)

/** Snapshot over the shared settings controller. */
export class OutputLanguagesService extends Service {
  private cachedFrom: ReviewSettingsState | undefined
  private cached: OutputLanguagesSnapshot | undefined

  /**
   * @param ctx - client root context.
   * @param controller - the settings controller every surface of this package shares.
   */
  constructor(ctx: Context, private readonly controller: ReviewSettingsController) {
    super(ctx, 'outputLanguages')
    // Pane headers render on every page, so the settings are followed from the start.
    void this.controller.load()
  }

  /** @returns the current view; identity changes only when the settings do. */
  getSnapshot(): OutputLanguagesSnapshot {
    const state = this.controller.store.getSnapshot()
    if (this.cached !== undefined && this.cachedFrom === state) return this.cached
    const languages = state.outputLanguage
    this.cachedFrom = state
    this.cached = {
      ready: state.status === 'ready' || state.status === 'saving' || state.status === 'error',
      writable: state.writable,
      saving: state.status === 'saving',
      options: OPTIONS,
      valueFor: (preset) => {
        const window = outputLanguageWindowOf(preset)
        return window === undefined ? undefined : languages[window]
      },
      labelFor: (tag) => {
        const language = outputLanguageOf(tag)
        return language === undefined ? undefined : outputLanguageLabel(language)
      },
    }
    return this.cached
  }

  /**
   * @param listener - called on every settings change.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    return this.controller.store.subscribe(listener)
  }

  /**
   * Store one window's language, named by the pane's preset.
   * @param preset - the pane's agent preset.
   * @param tag - a table tag, or blank for not specified.
   * @returns whether the write landed; false for a preset that is no window.
   */
  save(preset: string, tag: string): Promise<boolean> {
    const window = outputLanguageWindowOf(preset)
    if (window === undefined) return Promise.resolve(false)
    return this.controller.saveOutputLanguage(window, tag === '' ? UNSPECIFIED_OUTPUT_LANGUAGE : tag)
  }
}
