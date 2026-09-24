/**
 * Read-only translation of one project's `.dsh/hooks/` files into the rows the
 * settings page renders. Pure: it takes file text in and returns view data; it
 * never reads, writes, or otherwise touches a filesystem.
 *
 * Accept/reject is never re-decided here. `parseDshHookConfig` from the hook
 * runtime is the only authority on whether a file runs, `selectHookConfig` is
 * the only authority on which file a window uses, and
 * `DSH_HOOK_EVENT_EFFECTS` is the only authority on what the runtime does with
 * a hook's output. This module adds two things on top: where in the file a
 * problem sits, and what a command can be seen to declare.
 * @module @psychiiii/dsh-three-window-review/client/hook-view
 */

import {
  HookConfigError, parseDshHookConfig, selectHookConfig,
  type DshHookConfig, type HookFileState,
} from '@psychiiii/dsh-three-window-hooks/config'
import {
  DSH_HOOK_EVENTS, DSH_HOOK_EVENT_EFFECTS, DSH_HOOK_EVENT_SET, DSH_HOOK_MATCHER_MODE,
  type DshHookEvent, type DshHookEventEffects,
} from '@psychiiii/dsh-three-window-hooks/events'
import { DEFAULT_HOOK_FILE, WINDOW_KEYS, type WindowKey } from '@psychiiii/dsh-three-window-hooks/windows'
import { matcherDiagnostic } from '@deepseek-ai/dsh-hook-protocol'
import {
  firstSyntaxErrorLocation, jsonLineIndex, syntaxErrorLocation,
  type JsonPath, type SourceLocation,
} from './json-lines.ts'

export type { SourceLocation } from './json-lines.ts'
export { DSH_HOOK_EVENTS, DSH_HOOK_EVENT_EFFECTS, DEFAULT_HOOK_FILE, WINDOW_KEYS }
export type { DshHookEvent, DshHookEventEffects, WindowKey }

/** Filename stem of one file under `.dsh/hooks/`. */
export type HookFileStem = WindowKey | typeof DEFAULT_HOOK_FILE

/** Every stem the runtime opens, in the order the page lists them. */
export const HOOK_FILE_STEMS: readonly HookFileStem[] = [...WINDOW_KEYS, DEFAULT_HOOK_FILE]

/**
 * What the page can say about one command's `additionalContext`, from the
 * command text alone.
 *
 * Only `declared` means the text will reach the model, and even then only if
 * the command really emits what it appears to emit and exits 0 — a script that
 * fails at runtime prints nothing and injects nothing, which no reading of the
 * configuration can predict.
 */
export type InjectionVerdict =
  /** The command emits `additionalContext` under this event's own name. */
  | { readonly kind: 'declared' }
  /** The event drops context, and this command tries to supply some anyway. */
  | { readonly kind: 'event-ignores-context' }
  /** The event drops context, and this command does not try to supply any. */
  | { readonly kind: 'event-has-no-context-channel' }
  /** The command names a different event in `hookEventName`, so the block is discarded. */
  | { readonly kind: 'event-name-mismatch'; readonly declared: string }
  /** The command emits `additionalContext` with no `hookEventName`, so the block is discarded. */
  | { readonly kind: 'event-name-missing' }
  /** Nothing in the command text says either way; only the script itself decides. */
  | { readonly kind: 'undetermined' }

/** How a group's `matcher` is treated at this event. */
export type MatcherState =
  /** No `matcher` field: the group always fires. */
  | 'absent'
  /** `""` or `"*"`: the group always fires. */
  | 'match-all'
  /** Compared against this event's subject. */
  | 'honored'
  /** This event has no matcher subject; the parser drops the field. */
  | 'discarded'

/** One configured command, as the page shows it. */
export interface HookCommandView {
  readonly index: number
  readonly location: SourceLocation | undefined
  readonly command: string
  /** Per-hook timeout in seconds, when the file sets one. */
  readonly timeoutSec: number | undefined
  readonly injection: InjectionVerdict
  /** The command text shows `exit 2` or a deny/ask `permissionDecision`. */
  readonly declaresBlocking: boolean
}

/** One matcher group of one event. */
export interface HookGroupView {
  readonly index: number
  readonly location: SourceLocation | undefined
  /** The `matcher` exactly as written, or undefined when the field is absent. */
  readonly matcher: string | undefined
  readonly matcherState: MatcherState
  readonly hooks: readonly HookCommandView[]
}

/** One event's groups inside one file. */
export interface HookEventView {
  readonly event: DshHookEvent
  readonly location: SourceLocation | undefined
  readonly effects: DshHookEventEffects
  readonly groups: readonly HookGroupView[]
}

/** One `.dsh/hooks/<stem>.json` as the page shows it. */
export type HookFileView =
  | { readonly stem: HookFileStem; readonly path: string; readonly status: 'missing' }
  | {
    readonly stem: HookFileStem
    readonly path: string
    readonly status: 'unreadable'
    /** The read failure, verbatim from the Host. */
    readonly error: string
  }
  | {
    readonly stem: HookFileStem
    readonly path: string
    readonly status: 'invalid'
    readonly raw: string
    /** The runtime's own diagnostic, verbatim. */
    readonly error: string
    readonly location: SourceLocation | undefined
  }
  | {
    readonly stem: HookFileStem
    readonly path: string
    readonly status: 'ok'
    readonly raw: string
    /** The groups the runtime would run, straight from the runtime's parser. */
    readonly config: DshHookConfig
    readonly events: readonly HookEventView[]
  }

/** Which file actually runs for one window, and why none does when none does. */
export interface WindowHookView {
  readonly window: WindowKey
  readonly file: HookFileView
  readonly effective: 'window' | 'default' | 'none'
  readonly noneReason: 'window-invalid' | 'default-invalid' | 'absent' | undefined
}

/** Both quote styles a shell one-liner uses to spell a JSON key. */
function declaresKey(command: string, key: string): boolean {
  return new RegExp(`(["'])${key}\\1\\s*:`).test(command)
}

function declaredEventName(command: string): string | undefined {
  const match = /(["'])hookEventName\1\s*:\s*(["'])([A-Za-z]+)\2/.exec(command)
  return match?.[3]
}

/**
 * What the command text says about context injection at this event.
 * @param event - the event the group is configured under.
 * @param command - the configured command line.
 * @returns the verdict the page renders.
 */
export function analyzeInjection(event: DshHookEvent, command: string): InjectionVerdict {
  const declaresContext = declaresKey(command, 'additionalContext')
  if (!DSH_HOOK_EVENT_EFFECTS[event].injectsAdditionalContext) {
    return declaresContext ? { kind: 'event-ignores-context' } : { kind: 'event-has-no-context-channel' }
  }
  if (!declaresContext) return { kind: 'undetermined' }
  const declared = declaredEventName(command)
  if (declared === undefined) return { kind: 'event-name-missing' }
  return declared === event ? { kind: 'declared' } : { kind: 'event-name-mismatch', declared }
}

/**
 * Whether the command text shows a blocking outcome.
 * @param command - the configured command line.
 * @returns true when it contains `exit 2` or a deny/ask permission decision.
 */
export function declaresBlocking(command: string): boolean {
  return /\bexit\s+2\b/.test(command)
    || /(["'])permissionDecision\1\s*:\s*(["'])(deny|ask)\2/.test(command)
}

function matcherStateOf(event: DshHookEvent, matcher: string | undefined): MatcherState {
  if (DSH_HOOK_EVENT_EFFECTS[event].matcherSubject === 'discarded') {
    return matcher === undefined ? 'absent' : 'discarded'
  }
  if (matcher === undefined) return 'absent'
  if (matcher === '' || matcher === '*') return 'match-all'
  return matcherDiagnostic(matcher, DSH_HOOK_MATCHER_MODE) === undefined ? 'honored' : 'discarded'
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Locate the value a runtime diagnostic is about.
 *
 * The diagnostics name an event and, for the deeper checks, a group and hook
 * index; this reads those out of the message the parser already produced
 * rather than re-deciding anything. A message that names nothing locatable
 * yields undefined, and the page then points at the file instead of a line.
 * @param message - the `HookConfigError` message.
 * @param raw - the file text the error came from.
 * @param eventMap - the parsed event map the message refers to.
 * @param base - path prefix of the event map (`['hooks']` for a wrapped file).
 * @returns the position to send the reader to, when one can be derived.
 */
export function locateConfigError(
  message: string,
  raw: string,
  eventMap: Record<string, unknown>,
  base: JsonPath,
): SourceLocation | undefined {
  const index = jsonLineIndex(raw)
  const unsupported = /names unsupported hook events ((?:"[^"]*"(?:, )?)+)/.exec(message)
  if (unsupported !== null) {
    const first = /"([^"]*)"/.exec(unsupported[1] ?? '')?.[1]
    if (first !== undefined) return index.at([...base, first])
  }
  const event = /event "([^"]+)"/.exec(message)?.[1]
  if (event === undefined) return undefined
  const matcher = /regex matcher "([^"]*)"/.exec(message)?.[1]
  if (matcher !== undefined) {
    const group = groupOfMatcher(eventMap[event], matcher)
    return (group === undefined ? undefined : index.at([...base, event, group, 'matcher']))
      ?? index.at([...base, event])
  }
  const group = /group (\d+)/.exec(message)?.[1]
  const hook = /hook (\d+)/.exec(message)?.[1]
  if (group !== undefined && hook !== undefined) {
    return index.at([...base, event, Number(group), 'hooks', Number(hook)])
  }
  if (group !== undefined) return index.at([...base, event, Number(group)])
  return index.at([...base, event])
}

/** Index of the first group whose `matcher` is the rejected pattern. */
function groupOfMatcher(groups: unknown, matcher: string): number | undefined {
  if (!Array.isArray(groups)) return undefined
  const found = groups.findIndex(group => asObject(group)?.matcher === matcher)
  return found === -1 ? undefined : found
}

/**
 * Translate one file's text into view rows.
 *
 * `parseDshHookConfig` decides validity; a rejection is reported with the
 * runtime's own wording, wrapped exactly as `HookStore` wraps it, so the page
 * shows the same sentence the Host log shows.
 * @param stem - the file's name stem.
 * @param path - absolute path, used in the runtime's diagnostics.
 * @param raw - file text.
 * @returns the file view, valid or not.
 */
export function viewHookFile(stem: HookFileStem, path: string, raw: string): HookFileView {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      stem,
      path,
      status: 'invalid',
      raw,
      error: `personal-hooks: failed to parse ${path}: ${message} — that window group is disabled`,
      location: syntaxErrorLocation(message, raw) ?? firstSyntaxErrorLocation(raw),
    }
  }
  const root = asObject(parsed) ?? {}
  const wrappedMap = asObject(root.hooks)
  const eventMap = wrappedMap ?? root
  const base: JsonPath = wrappedMap === undefined ? [] : ['hooks']
  let config: DshHookConfig
  try {
    config = parseDshHookConfig(parsed, path)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      stem,
      path,
      status: 'invalid',
      raw,
      error: error instanceof HookConfigError
        ? message
        : `personal-hooks: failed to parse ${path}: ${message} — that window group is disabled`,
      location: locateConfigError(message, raw, eventMap, base),
    }
  }
  return { stem, path, status: 'ok', raw, config, events: eventViews(eventMap, raw, base) }
}

function eventViews(eventMap: Record<string, unknown>, raw: string, base: JsonPath): HookEventView[] {
  const index = jsonLineIndex(raw)
  const views: HookEventView[] = []
  for (const event of DSH_HOOK_EVENTS) {
    const rawGroups = eventMap[event]
    if (!Array.isArray(rawGroups)) continue
    const groups: HookGroupView[] = []
    for (const [groupIndex, rawGroup] of rawGroups.entries()) {
      const group = asObject(rawGroup)
      if (group === undefined) continue
      const matcher = typeof group.matcher === 'string' ? group.matcher : undefined
      const hooks: HookCommandView[] = []
      const rawHooks = Array.isArray(group.hooks) ? group.hooks : []
      for (const [hookIndex, rawHook] of rawHooks.entries()) {
        const hook = asObject(rawHook)
        if (hook === undefined || typeof hook.command !== 'string') continue
        hooks.push({
          index: hookIndex,
          location: index.at([...base, event, groupIndex, 'hooks', hookIndex]),
          command: hook.command,
          timeoutSec: typeof hook.timeout === 'number' ? hook.timeout : undefined,
          injection: analyzeInjection(event, hook.command),
          declaresBlocking: declaresBlocking(hook.command),
        })
      }
      groups.push({
        index: groupIndex,
        location: index.at([...base, event, groupIndex]),
        matcher,
        matcherState: matcherStateOf(event, matcher),
        hooks,
      })
    }
    views.push({
      event,
      location: index.at([...base, event]),
      effects: DSH_HOOK_EVENT_EFFECTS[event],
      groups,
    })
  }
  return views
}

/** The `HookFileState` the runtime would hold for one already-translated file. */
function stateOf(view: HookFileView): HookFileState | undefined {
  if (view.status === 'missing') return undefined
  if (view.status === 'ok') return { status: 'ok', config: view.config }
  // An unreadable file is not "absent": the runtime finds it and fails on it,
  // so it must not silently fall through to default.json here either.
  return { status: 'invalid', error: view.error }
}

/**
 * Which file each window actually runs, under the runtime's own selection rule.
 * @param files - one view per stem, as read from the project.
 * @returns one row per window, in {@link WINDOW_KEYS} order.
 */
export function windowViews(files: ReadonlyMap<HookFileStem, HookFileView>): WindowHookView[] {
  const fallback = files.get(DEFAULT_HOOK_FILE)
  return WINDOW_KEYS.map((window) => {
    const file = files.get(window) ?? { stem: window, path: '', status: 'missing' as const }
    const choice = selectHookConfig(
      stateOf(file),
      fallback === undefined ? undefined : stateOf(fallback),
    )
    return {
      window,
      file,
      effective: choice.source,
      noneReason: choice.source === 'none' ? choice.reason : undefined,
    }
  })
}

/** Whether a name is one this runtime dispatches. */
export function isKnownHookEvent(name: string): name is DshHookEvent {
  return DSH_HOOK_EVENT_SET.has(name)
}
