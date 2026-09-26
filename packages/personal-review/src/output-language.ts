/**
 * Model output language: the fixed option table, the per-window setting shape,
 * and the text that reaches models.
 *
 * Everything a model is told about the language is derived from
 * {@link OUTPUT_LANGUAGES}; nothing the user types reaches a prompt, because a
 * setting can only hold one of the table's tags. The rule that tells a model
 * how to read the tag is a constant in the window presets' persona suffix, so
 * changing a window's language changes only the short per-turn tag and never
 * the system prompt.
 * @module @psychiiii/dsh-three-window-review/output-language
 */

/** One selectable output language. */
export interface OutputLanguage {
  /** BCP 47 tag; the stored value. */
  readonly tag: string
  /** English name, the part every model reads unambiguously. */
  readonly english: string
  /** Name written in the language itself. */
  readonly native: string
}

/** Every language a window can be set to, in menu order. */
export const OUTPUT_LANGUAGES: readonly OutputLanguage[] = Object.freeze([
  { tag: 'zh-CN', english: 'Simplified Chinese', native: '简体中文' },
  { tag: 'zh-TW', english: 'Traditional Chinese', native: '繁體中文' },
  { tag: 'en-US', english: 'English', native: 'English' },
  { tag: 'ja-JP', english: 'Japanese', native: '日本語' },
  { tag: 'ko-KR', english: 'Korean', native: '한국어' },
  { tag: 'fr-FR', english: 'French', native: 'Français' },
  { tag: 'de-DE', english: 'German', native: 'Deutsch' },
  { tag: 'es-ES', english: 'Spanish', native: 'Español' },
  { tag: 'pt-BR', english: 'Portuguese', native: 'Português' },
  { tag: 'ru-RU', english: 'Russian', native: 'Русский' },
])

/** The stored value meaning "not specified": nothing is injected. */
export const UNSPECIFIED_OUTPUT_LANGUAGE = ''

/** Every value a window's setting may hold: unspecified, then each tag. */
export const OUTPUT_LANGUAGE_VALUES: readonly string[] = Object.freeze([
  UNSPECIFIED_OUTPUT_LANGUAGE, ...OUTPUT_LANGUAGES.map(language => language.tag),
])

/** The three windows, keyed like the hook files and the workbench panes. */
export const OUTPUT_LANGUAGE_WINDOWS = ['chat', 'construct', 'review'] as const

/** One window key. */
export type OutputLanguageWindow = (typeof OUTPUT_LANGUAGE_WINDOWS)[number]

/**
 * The agent preset each window runs, as `personal-web` declares them. Only a
 * root Session on one of these presets receives the per-turn tag.
 */
export const OUTPUT_LANGUAGE_PRESETS: Readonly<Record<OutputLanguageWindow, string>> = Object.freeze({
  chat: 'personal-chat',
  construct: 'personal-construct',
  review: 'personal-review',
})

/**
 * Window a preset belongs to.
 * @param preset - an agent preset id.
 * @returns the window, or undefined for any other preset.
 */
export function outputLanguageWindowOf(preset: string | undefined): OutputLanguageWindow | undefined {
  return OUTPUT_LANGUAGE_WINDOWS.find(window => OUTPUT_LANGUAGE_PRESETS[window] === preset)
}

/** Output language per window; each value is a tag or {@link UNSPECIFIED_OUTPUT_LANGUAGE}. */
export type OutputLanguageSettings = Record<OutputLanguageWindow, string>

/** Every window unspecified. */
export const DEFAULT_OUTPUT_LANGUAGES: Readonly<OutputLanguageSettings> = Object.freeze({
  chat: UNSPECIFIED_OUTPUT_LANGUAGE,
  construct: UNSPECIFIED_OUTPUT_LANGUAGE,
  review: UNSPECIFIED_OUTPUT_LANGUAGE,
})

/**
 * Look a tag up in the table.
 * @param tag - a stored value.
 * @returns the language, or undefined for unspecified and for any value the table lacks.
 */
export function outputLanguageOf(tag: string | undefined): OutputLanguage | undefined {
  return OUTPUT_LANGUAGES.find(language => language.tag === tag)
}

/**
 * Menu label: the tag with its native name, e.g. `zh-CN（简体中文）`.
 * @param language - one table entry.
 * @returns the label shown in both locales.
 */
export function outputLanguageLabel(language: OutputLanguage): string {
  return `${language.tag}（${language.native}）`
}

/**
 * Read one window's value out of a stored section, tolerating anything.
 *
 * A value the table does not know reads as unspecified, so a hand-edited
 * profile can never put free text into a prompt.
 * @param section - the `personal-settings` Config section, or any object.
 * @returns the three windows' values, each a known tag or unspecified.
 */
export function outputLanguagesFromSection(section: unknown): OutputLanguageSettings {
  const raw = section !== null && typeof section === 'object' && !Array.isArray(section)
    ? (section as { outputLanguage?: unknown }).outputLanguage
    : undefined
  const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const read = (window: OutputLanguageWindow): string => {
    const value = record[window]
    return typeof value === 'string' && outputLanguageOf(value) !== undefined
      ? value
      : UNSPECIFIED_OUTPUT_LANGUAGE
  }
  return { chat: read('chat'), construct: read('construct'), review: read('review') }
}

/**
 * Whether the first-entry prompt has been answered, read out of a stored section.
 * @param section - the `personal-settings` Config section, or any object.
 * @returns true only when the stored flag is exactly true.
 */
export function outputLanguagePromptedFromSection(section: unknown): boolean {
  return section !== null && typeof section === 'object' && !Array.isArray(section)
    && (section as { outputLanguagePrompted?: unknown }).outputLanguagePrompted === true
}

/**
 * The per-turn tag a window's model receives.
 * @param tag - the window's stored value.
 * @returns the tag text, or undefined when nothing is to be injected.
 */
export function outputLanguageTag(tag: string | undefined): string | undefined {
  const language = outputLanguageOf(tag)
  if (language === undefined) return undefined
  return `<output-language tag="${language.tag}">${language.english} (${language.native})</output-language>`
}

/**
 * The fixed rule the window presets carry in their persona suffix. Kept here
 * so a test can hold the presets to the same wording.
 */
export const OUTPUT_LANGUAGE_RULE =
  'A user turn may carry an <output-language> tag. When it does, write everything you say to the user in that language. '
  + 'Code, identifiers, file contents, and commit messages follow the project\'s existing conventions instead. '
  + 'If the user explicitly asks for a different language, follow the user.'

/**
 * The line a review seat receives about its natural-language fields.
 * @param tag - the review window's stored value.
 * @returns the line, or undefined when the review window is unspecified.
 */
export function seatOutputLanguageLine(tag: string | undefined): string | undefined {
  const language = outputLanguageOf(tag)
  if (language === undefined) return undefined
  return `Write the text of every "evidence" and "claim" field in ${language.english} (${language.native}, ${language.tag}). `
    + 'Keep every JSON key and every enum value exactly as the protocol states.'
}
