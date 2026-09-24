/**
 * Parse one `.dsh/hooks/<window>.json` file. Unknown event names and non-command
 * handlers fail the whole file.
 * @module @psychiiii/dsh-three-window-hooks/config
 */

import { matcherDiagnostic, type MatcherGroup } from '@deepseek-ai/dsh-hook-protocol'
import { DSH_HOOK_EVENT_SET, DSH_HOOK_EVENTS, DSH_HOOK_MATCHER_MODE, type DshHookEvent } from './events.ts'

/** Parsed per-event matcher groups (command hooks only). */
export type DshHookConfig = Partial<Record<DshHookEvent, MatcherGroup[]>>

/** One candidate file: runnable groups, or a loud parse failure. */
export type HookFileState
  = { readonly status: 'ok'; readonly config: DshHookConfig }
  | { readonly status: 'invalid'; readonly error: string }

/** Which candidate file runs for one window, and why nothing runs when nothing does. */
export type HookFileChoice
  = { readonly source: 'window' | 'default'; readonly config: DshHookConfig }
  | { readonly source: 'none'; readonly reason: 'window-invalid' | 'default-invalid' | 'absent' }

/**
 * The three-level rule, in one place: the window file if present and valid;
 * else `default.json` if present and valid; else nothing. A present but
 * invalid window file disables that window and does NOT fall back to default,
 * so a typo in `review.json` silently swaps in `default.json` for nobody.
 * @param own - state of `<window>.json`, or undefined when the file is absent.
 * @param fallback - state of `default.json`, or undefined when that file is absent.
 * @returns the file that runs, or the reason none does.
 */
export function selectHookConfig(
  own: HookFileState | undefined,
  fallback: HookFileState | undefined,
): HookFileChoice {
  if (own !== undefined) {
    return own.status === 'ok'
      ? { source: 'window', config: own.config }
      : { source: 'none', reason: 'window-invalid' }
  }
  if (fallback === undefined) return { source: 'none', reason: 'absent' }
  return fallback.status === 'ok'
    ? { source: 'default', config: fallback.config }
    : { source: 'none', reason: 'default-invalid' }
}

/** Why one file cannot run. */
export class HookConfigError extends Error {
  /**
   * @param message - diagnostic, including the file path when known.
   */
  constructor(message: string) {
    super(message)
    this.name = 'HookConfigError'
  }
}

/** A plain object, else undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Parse a settings-style `{ hooks: … }` wrapper or a bare event map.
 *
 * Unknown event names, non-command handler types, missing `command` strings,
 * and invalid matchers throw {@link HookConfigError} so the window group is
 * disabled. Matcher fields on UserPromptSubmit and Stop are discarded because
 * those events have no matcher subject.
 * @param raw - parsed JSON.
 * @param path - file path used in diagnostics.
 * @returns runnable per-event groups.
 * @throws {@link HookConfigError} when the file is not a valid config.
 */
export function parseDshHookConfig(raw: unknown, path: string): DshHookConfig {
  const root = asObject(raw)
  if (root === undefined) {
    throw new HookConfigError(`personal-hooks: ${path} must be a JSON object`)
  }
  // A settings wrapper's sibling keys are not event names. Bare event maps
  // treat every key as an event name.
  const eventMap = asObject(root.hooks) ?? root
  const rejected = Object.keys(eventMap).filter(key => !DSH_HOOK_EVENT_SET.has(key))
  if (rejected.length > 0) {
    throw new HookConfigError(
      `personal-hooks: ${path} names unsupported hook events ${rejected.map(name => JSON.stringify(name)).join(', ')}; `
      + `supported: ${DSH_HOOK_EVENTS.join(', ')}`,
    )
  }

  const config: DshHookConfig = {}
  for (const event of DSH_HOOK_EVENTS) {
    const rawGroups = eventMap[event]
    if (rawGroups === undefined) continue
    if (!Array.isArray(rawGroups)) {
      throw new HookConfigError(`personal-hooks: ${path} event ${JSON.stringify(event)} must be an array of matcher groups`)
    }
    const groups: MatcherGroup[] = []
    for (const [groupIndex, rawGroup] of rawGroups.entries()) {
      const group = asObject(rawGroup)
      if (group === undefined || !Array.isArray(group.hooks)) {
        throw new HookConfigError(
          `personal-hooks: ${path} event ${JSON.stringify(event)} group ${String(groupIndex)} must be an object with a hooks array`,
        )
      }
      const commands: MatcherGroup['hooks'] = []
      for (const [hookIndex, rawHook] of group.hooks.entries()) {
        const hook = asObject(rawHook)
        if (hook === undefined) {
          throw new HookConfigError(
            `personal-hooks: ${path} event ${JSON.stringify(event)} group ${String(groupIndex)} hook ${String(hookIndex)} must be an object`,
          )
        }
        const type = typeof hook.type === 'string' ? hook.type : 'command'
        if (type !== 'command') {
          throw new HookConfigError(
            `personal-hooks: ${path} event ${JSON.stringify(event)} group ${String(groupIndex)} hook ${String(hookIndex)} `
            + `has unsupported type ${JSON.stringify(type)}; only { "type": "command", "command", "timeout" } is accepted`,
          )
        }
        if (typeof hook.command !== 'string' || hook.command.length === 0) {
          throw new HookConfigError(
            `personal-hooks: ${path} event ${JSON.stringify(event)} group ${String(groupIndex)} hook ${String(hookIndex)} `
            + 'requires a non-empty command string',
          )
        }
        if (hook.timeout !== undefined && (typeof hook.timeout !== 'number' || !Number.isFinite(hook.timeout) || hook.timeout < 0)) {
          throw new HookConfigError(
            `personal-hooks: ${path} event ${JSON.stringify(event)} group ${String(groupIndex)} hook ${String(hookIndex)} `
            + 'timeout must be a non-negative number of seconds',
          )
        }
        commands.push({
          command: hook.command,
          ...typeof hook.timeout === 'number' ? { timeoutSec: hook.timeout } : {},
        })
      }
      if (commands.length === 0) continue
      const matcher = event === 'UserPromptSubmit' || event === 'Stop'
        ? undefined
        : typeof group.matcher === 'string' ? group.matcher : undefined
      const diagnostic = matcherDiagnostic(matcher, DSH_HOOK_MATCHER_MODE)
      if (diagnostic !== undefined) {
        throw new HookConfigError(`${diagnostic} on event ${JSON.stringify(event)} in ${path}`)
      }
      groups.push({
        ...matcher !== undefined ? { matcher } : {},
        hooks: commands,
      })
    }
    if (groups.length > 0) config[event] = groups
  }
  return config
}
