/**
 * Window identity for hook dispatch: root-session preset, then Config mapping.
 * @module @psychiiii/dsh-three-window-hooks/windows
 */

import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Filenames under `<project>/.dsh/hooks/` that name a window group. */
export const WINDOW_KEYS = ['chat', 'construct', 'review'] as const

/** One window filename stem. */
export type WindowKey = (typeof WINDOW_KEYS)[number]

/** Filename used when a window file is absent. */
export const DEFAULT_HOOK_FILE = 'default'

/** Preset id assigned to each window. */
export interface WindowPresets {
  readonly chat: string
  readonly construct: string
  readonly review: string
}

/** Invertible preset-to-window table used at dispatch. */
export interface WindowMapping {
  readonly windows: WindowPresets
  readonly presetToWindow: ReadonlyMap<string, WindowKey>
}

/** Session store subset the parent-chain walk needs. */
export interface SessionLookup {
  get(id: SessionId): Session | undefined
}

/** Reads the live preset id for one session (projection, else header). */
export type PresetReader = (session: Session) => string | undefined

/**
 * Build the preset-to-window table. Preset ids must be unique.
 * @param windows - three preset ids, one per window filename.
 * @returns the mapping used at dispatch.
 * @throws when two windows share a preset id.
 */
export function windowMapping(windows: WindowPresets): WindowMapping {
  const presetToWindow = new Map<string, WindowKey>()
  for (const key of WINDOW_KEYS) {
    const preset = windows[key]
    if (preset.length === 0) {
      throw new Error(`personal-hooks window preset for ${key} must be non-empty`)
    }
    if (presetToWindow.has(preset)) {
      throw new Error(`personal-hooks window presets must be unique, got duplicate ${JSON.stringify(preset)}`)
    }
    presetToWindow.set(preset, key)
  }
  return { windows, presetToWindow }
}

/**
 * Walk `header.parentSession` until a session with no live parent.
 *
 * A missing ancestor is fail-closed: the walk returns `undefined` (no window).
 * A cycle stops at the last reachable session already in `seen` and does not
 * throw — that session is treated as the root.
 * @param session - the agent session that raised the hook point.
 * @param sessions - live session store.
 * @returns the root of the parent chain, or `undefined` when an ancestor id
 *   cannot be resolved.
 */
export function rootSession(session: Session, sessions: SessionLookup): Session | undefined {
  let current = session
  const seen = new Set<string>()
  for (;;) {
    const parentId = current.header.parentSession
    if (parentId === undefined || parentId.length === 0) return current
    if (seen.has(current.id)) return current
    seen.add(current.id)
    const parent = sessions.get(parentId as SessionId)
    if (parent === undefined) return undefined
    current = parent
  }
}

/**
 * Current preset id of one session: optional reader first, then the creation header.
 * @param session - session to read.
 * @param readPreset - optional live reader (typically the `agentPreset` projection).
 * @returns the preset id, or undefined when neither source has one.
 */
export function presetOf(session: Session, readPreset?: PresetReader): string | undefined {
  const projected = readPreset?.(session)
  if (typeof projected === 'string' && projected.length > 0) return projected
  const header = session.header.agentPreset
  return header !== undefined && header.length > 0 ? header : undefined
}

/**
 * Window that owns this session: root of the parent chain, then that root's preset.
 *
 * Rule, as tested: take the agent's session, walk `header.parentSession` to the
 * root, read the root's `agentPreset` (projection, else header), map it through
 * {@link WindowMapping.presetToWindow}. An unknown preset is not a window. A
 * missing ancestor is not a window.
 * @param session - session that raised the hook point (parent or descendant).
 * @param sessions - live session store.
 * @param mapping - preset-to-window table from plugin Config.
 * @param readPreset - optional live reader (typically the `agentPreset` projection).
 * @returns the window key, or undefined when the root preset is not mapped.
 */
export function windowOfSession(
  session: Session,
  sessions: SessionLookup,
  mapping: WindowMapping,
  readPreset?: PresetReader,
): WindowKey | undefined {
  const root = rootSession(session, sessions)
  if (root === undefined) return undefined
  const preset = presetOf(root, readPreset)
  if (preset === undefined) return undefined
  return mapping.presetToWindow.get(preset)
}

/**
 * Window that owns this agent. Delegates to {@link windowOfSession}.
 * @param agent - agent that raised the hook point.
 * @param sessions - live session store.
 * @param mapping - preset-to-window table from plugin Config.
 * @param readPreset - optional live reader (typically the `agentPreset` projection).
 * @returns the window key, or undefined when the root preset is not mapped.
 */
export function windowOfAgent(
  agent: Agent,
  sessions: SessionLookup,
  mapping: WindowMapping,
  readPreset?: PresetReader,
): WindowKey | undefined {
  return windowOfSession(agent.session, sessions, mapping, readPreset)
}
