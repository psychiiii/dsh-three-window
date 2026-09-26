/**
 * Per-turn context for the three windows: the Workspace's turn prompt and the
 * window's output-language tag.
 *
 * On every Step that admits a user's message, a window's root Session gets up
 * to two short user-role contexts, appended after the admitted batch on the
 * same `agent/pre-step` point the hook runtime uses, always in this order:
 * the user's text, then the Workspace prompt, then the language tag, so the
 * language tag is the last thing the model reads. Both values are read at that
 * moment, so a change in settings applies from the user's next message on;
 * the rules that explain both wrappers are constants in each preset's persona
 * suffix, so neither setting ever touches the system prompt.
 *
 * Subagent Sessions and every Session outside the three window presets are
 * left alone; a subagent's prose reaches the user only through its parent.
 * @module @psychiiii/dsh-three-window-settings/turn-injections
 */

import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import {
  outputLanguageLabel, outputLanguageOf, outputLanguageTag, outputLanguageWindowOf,
  type OutputLanguageSettings,
} from '@psychiiii/dsh-three-window-review/output-language'
import { workspacePromptBlock, type WorkspacePromptEntry } from '@psychiiii/dsh-three-window-review/workspace-prompt'

/** Message source kind of the per-turn language tag. */
export const OUTPUT_LANGUAGE_SOURCE_KIND = 'output-language'

/** Message source kind of the per-turn Workspace prompt. */
export const WORKSPACE_PROMPT_SOURCE_KIND = 'workspace-prompt'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The per-turn output-language tag of one window. */
    'output-language': { kind: 'output-language'; tag: string } & ContextFormed
    /** The per-turn prompt of the Workspace a window works in. */
    'workspace-prompt': { kind: 'workspace-prompt'; root: string }
  }
}

/** Reads a Session's live preset id (the `agentPreset` projection). */
export type ProjectedPreset = (session: Session) => unknown

/** What the per-turn contexts are built from, read at each Step. */
export interface TurnSettings {
  /** Each window's output language. */
  readonly languages: OutputLanguageSettings
  /** Each Workspace's turn prompt. */
  readonly workspacePrompts: readonly WorkspacePromptEntry[]
}

/**
 * The preset a Session runs now: the live projection, else the creation header.
 * @param session - the Session.
 * @param projected - live projection reader.
 * @returns the preset id, or undefined.
 */
function presetOf(session: Session, projected: ProjectedPreset): string | undefined {
  const live = projected(session)
  if (typeof live === 'string' && live.length > 0) return live
  const header = session.header.agentPreset
  return header !== undefined && header.length > 0 ? header : undefined
}

/**
 * The Workspace prompt entry whose root holds this working directory; nested
 * Workspaces resolve to the deepest root.
 * @param entries - stored entries (normalized roots).
 * @param cwd - the Session's working directory.
 * @returns the entry, or undefined when no root holds the directory.
 */
export function workspacePromptFor(
  entries: readonly WorkspacePromptEntry[],
  cwd: string | undefined,
): WorkspacePromptEntry | undefined {
  if (cwd === undefined || cwd.length === 0) return undefined
  const target = resolve(cwd)
  let best: WorkspacePromptEntry | undefined
  let bestLength = -1
  for (const entry of entries) {
    const root = resolve(entry.root)
    const inside = relative(root, target)
    if (inside.startsWith('..') || isAbsolute(inside)) continue
    if (root.length > bestLength) {
      best = entry
      bestLength = root.length
    }
  }
  return best
}

/**
 * The contexts to append to one agent's Step, in order.
 * @param agent - the agent about to step.
 * @param admitted - the batch this Step admits.
 * @param settings - both settings, read now.
 * @param projected - live preset reader.
 * @returns zero, one, or two messages: Workspace prompt first, language tag last.
 */
export function turnInjections(
  agent: Agent,
  admitted: readonly { source: MessageSource }[],
  settings: TurnSettings,
  projected: ProjectedPreset,
): UserMessage[] {
  if (!admitted.some(message => message.source.kind === 'user')) return []
  const parent = agent.session.header.parentSession
  if (parent !== undefined && parent.length > 0) return []
  const window = outputLanguageWindowOf(presetOf(agent.session, projected))
  if (window === undefined) return []
  const out: UserMessage[] = []
  const entry = workspacePromptFor(settings.workspacePrompts, agent.session.header.cwd)
  const block = workspacePromptBlock(entry?.prompt)
  if (entry !== undefined && block !== undefined) {
    out.push(createUserMessage({
      content: [{ type: 'text', text: block }],
      source: { kind: WORKSPACE_PROMPT_SOURCE_KIND, root: entry.root },
    }))
  }
  const language = outputLanguageOf(settings.languages[window])
  const tag = outputLanguageTag(settings.languages[window])
  if (language !== undefined && tag !== undefined) {
    out.push(createUserMessage({
      content: [{ type: 'text', text: tag }],
      source: {
        kind: OUTPUT_LANGUAGE_SOURCE_KIND,
        tag: language.tag,
        form: 'notice',
        summary: outputLanguageLabel(language),
      },
    }))
  }
  return out
}

/**
 * Append each window's per-turn contexts on the Steps that admit a user's message.
 * @param ctx - a Host context carrying `sessionProjections`.
 * @param settings - reads both settings at the moment of use.
 */
export function applyTurnInjections(ctx: Context, settings: () => TurnSettings): void {
  const projected: ProjectedPreset = session =>
    (ctx.sessionProjections as { stateOf(target: Session, key: string): unknown }).stateOf(session, 'agentPreset')
  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    const extra = turnInjections(agent, messages, settings(), projected)
    return extra.length === 0 ? downstream : { ...downstream, messages: [...downstream.messages, ...extra] }
  })
}
