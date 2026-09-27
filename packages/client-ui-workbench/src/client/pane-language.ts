/**
 * The model output language shown in each pane header, and the selector that
 * changes it. The setting belongs to the settings package, which provides the
 * `outputLanguages` service; this module only types the part the panel reads,
 * so neither package imports the other and a composition without that service
 * shows no selector.
 * @module @psychiiii/dsh-three-window-workbench/client/pane-language
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** One selectable language: the stored tag and its label. */
export interface PaneLanguageOption {
  readonly tag: string
  readonly label: string
}

/** The pane headers' view of the output languages. */
export interface PaneLanguagesView {
  /** False when no settings package supplies the service: no selector at all. */
  readonly available: boolean
  /** True once the stored values are known. */
  readonly ready: boolean
  /** Whether this page may write settings. */
  readonly writable: boolean
  /** Whether a write is in flight. */
  readonly saving: boolean
  /** Every language, in menu order ("not specified" is the blank tag, not listed). */
  readonly options: readonly PaneLanguageOption[]
  /** Stored tag per pane, left to right; blank is not specified, undefined is no window. */
  readonly values: readonly [string | undefined, string | undefined, string | undefined]
  /** Label of a tag, or undefined for blank or unknown. */
  labelFor(tag: string): string | undefined
}

/** The view without the settings package. */
export const NO_PANE_LANGUAGES: PaneLanguagesView = Object.freeze({
  available: false,
  ready: false,
  writable: false,
  saving: false,
  options: [],
  values: [undefined, undefined, undefined] as const,
  labelFor: () => undefined,
})

/** The part of the settings package's `outputLanguages` service this module reads. */
interface OutputLanguagesSource {
  getSnapshot(): {
    readonly ready: boolean
    readonly writable: boolean
    readonly saving: boolean
    readonly options: readonly PaneLanguageOption[]
    valueFor(preset: string): string | undefined
    labelFor(tag: string): string | undefined
  }
  subscribe(listener: () => void): () => void
  save(preset: string, tag: string): Promise<boolean>
}

/**
 * The pane headers' observable view and their one write, over the service as
 * it is at the moment of use. The service may register before or after the
 * workbench applies, so reads are live and a subscription follows its arrival
 * through `internal/service`.
 * @param ctx - client root context.
 * @param presets - each pane's agent preset, left to right.
 * @returns the observable view and the save action.
 */
export function paneLanguages(ctx: Context, presets: readonly string[]): {
  view: HostObservable<PaneLanguagesView>
  save: (index: number, tag: string) => Promise<boolean>
} {
  const source = (): OutputLanguagesSource | undefined => ctx.get('outputLanguages') as OutputLanguagesSource | undefined
  let from: object | undefined
  let cached: PaneLanguagesView = NO_PANE_LANGUAGES
  const getSnapshot = (): PaneLanguagesView => {
    const service = source()
    if (service === undefined) return NO_PANE_LANGUAGES
    const snapshot = service.getSnapshot()
    if (snapshot === from) return cached
    from = snapshot
    const valueAt = (index: number): string | undefined => {
      const preset = presets[index]
      return preset === undefined ? undefined : snapshot.valueFor(preset)
    }
    cached = {
      available: true,
      ready: snapshot.ready,
      writable: snapshot.writable,
      saving: snapshot.saving,
      options: snapshot.options,
      values: [valueAt(0), valueAt(1), valueAt(2)],
      labelFor: tag => snapshot.labelFor(tag),
    }
    return cached
  }
  const subscribe = (listener: () => void): () => void => {
    let inner = source()?.subscribe(listener)
    const off = ctx.on('internal/service', (name) => {
      if (name !== 'outputLanguages') return
      inner?.()
      inner = source()?.subscribe(listener)
      listener()
    })
    return () => {
      off()
      inner?.()
    }
  }
  return {
    view: { getSnapshot, subscribe },
    save: (index, tag) => {
      const service = source()
      const preset = presets[index]
      return service === undefined || preset === undefined ? Promise.resolve(false) : service.save(preset, tag)
    },
  }
}
