/**
 * Native hook runtime: per-window command hooks from `<project>/.dsh/hooks/`,
 * dispatched on the same interception points the official bridges use.
 * @module @psychiiii/dsh-three-window-hooks
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision, TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import {
  appendHookInvoked,
  appendHookResult,
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  matchesMatcher,
  mergeHookOutputs,
  runHook,
  type HookOutput,
  type MatcherGroup,
  type MergedHookOutcome,
} from '@deepseek-ai/dsh-hook-protocol'
import { DSH_HOOK_DIALECT, DSH_HOOK_MATCHER_MODE, DSH_SUBAGENT_TYPE, type DshHookEvent } from './events.ts'
import {
  postToolPayload,
  preToolPayload,
  promptPayload,
  sessionStartPayload,
  stopPayload,
  subagentPayload,
} from './payloads.ts'
import { HookStore } from './store.ts'
import {
  windowMapping,
  windowOfAgent,
  type WindowMapping,
  type WindowPresets,
} from './windows.ts'
import type { DshHookConfig } from './config.ts'

export {
  DSH_HOOK_DIALECT,
  DSH_HOOK_EVENT_EFFECTS,
  DSH_HOOK_EVENT_SET,
  DSH_HOOK_EVENTS,
  DSH_HOOK_MATCHER_MODE,
  DSH_SUBAGENT_TYPE,
  type DshHookEvent,
  type DshHookEventEffects,
} from './events.ts'
export { DEFAULT_HOOK_FILE, WINDOW_KEYS, windowMapping, windowOfAgent, windowOfSession, type WindowKey } from './windows.ts'
export {
  HookConfigError, parseDshHookConfig, selectHookConfig,
  type DshHookConfig, type HookFileChoice, type HookFileState,
} from './config.ts'
export { HOOKS_RELATIVE_DIR, HookStore } from './store.ts'

export const name = 'personal-hooks'
export const inject = ['shell', 'sessionProjections', 'sessions']

/** Plugin config: window-to-preset map and hook-run limits. */
export interface Config {
  /** Preset id for each window filename. Defaults match personal-web. */
  windows?: Partial<WindowPresets>
  /** Default per-hook timeout in ms when a hook sets none. */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
}

/** Schemastery configuration for the host row. */
export const Config: z<Config> = z.object({
  windows: z.object({
    chat: z.string().default('personal-chat'),
    construct: z.string().default('personal-construct'),
    review: z.string().default('personal-review'),
  }).default({
    chat: 'personal-chat',
    construct: 'personal-construct',
    review: 'personal-review',
  }),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
})

/** A message this plugin's window hooks put into a conversation (hook context or a steer). */
export interface WindowHookMessageSource {
  readonly kind: 'personal-hooks'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Context and steers added by the per-window hook runtime. */
    'personal-hooks': WindowHookMessageSource
  }
}

const PLUGIN_SOURCE: MessageSource = { kind: 'personal-hooks' }

let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `personal:${point}:${++handlerCounter}`
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`personal-hooks: ${field} must be a positive integer`)
  }
}

/**
 * Resolve Config defaults into a unique preset-to-window table.
 * @param config - plugin row after schemastery.
 * @returns mapping used at dispatch.
 */
export function resolveWindowMapping(config: Config): WindowMapping {
  return windowMapping({
    chat: config.windows?.chat ?? 'personal-chat',
    construct: config.windows?.construct ?? 'personal-construct',
    review: config.windows?.review ?? 'personal-review',
  })
}

/**
 * Register interception listeners. Config is read from each session workspace's
 * `.dsh/hooks/` directory; Claude Code settings directories are never opened.
 * @param ctx - host context carrying `shell` and `sessionProjections`.
 * @param config - window mapping and timeouts.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger('stderrSummaryMaxChars', stderrSummaryMaxChars)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const mapping = resolveWindowMapping(config)
  const store = new HookStore({
    error: (message) => { ctx.logger.error(message) },
  })
  const detached = createDetachedRuns()
  const subagentChildren = new Map<SubagentRunId, Agent>()

  ctx.effect(() => () => {
    store.dispose()
    return detached.drain()
  }, 'personal-hooks: dispose store and detached hook runs')

  function lastTurn(agent: Agent | undefined): number | undefined {
    if (!agent) return undefined
    const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary') as TurnBoundaryProjection | undefined
    if (boundary === undefined || boundary.openTurnStartSeq === null) return undefined
    return boundary.lastTurn
  }

  function contextFrom(merged: MergedHookOutcome): UserMessage | undefined {
    if (merged.additionalContext.length === 0) return undefined
    const content: ContentBlock[] = merged.additionalContext.map(text => ({ type: 'text', text }))
    return createUserMessage({ content, source: PLUGIN_SOURCE })
  }

  function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
    return [ours, ...theirs ?? []]
  }

  function configFor(agent: Agent | undefined): { groups: DshHookConfig; cwd: string } | undefined {
    if (agent === undefined) return undefined
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return undefined
    const window = windowOfAgent(agent, ctx.sessions, mapping, (session) => {
      const projected: unknown = (ctx.sessionProjections as { stateOf(target: Session, key: string): unknown })
        .stateOf(session, 'agentPreset')
      return typeof projected === 'string' && projected.length > 0 ? projected : undefined
    })
    if (window === undefined) return undefined
    const groups = store.select(cwd, window)
    if (groups === undefined) return undefined
    return { groups, cwd }
  }

  async function runPoint(
    point: DshHookEvent,
    matchQuery: string,
    payload: unknown,
    opts: { agent?: Agent; turn?: number; readonly signal: AbortSignal; cwd?: string },
  ): Promise<MergedHookOutcome> {
    const selected = configFor(opts.agent)
    const groups: MatcherGroup[] = selected?.groups[point] ?? []
    const outputs: HookOutput[] = []
    const workdir = opts.cwd ?? opts.agent?.session.header.cwd
    const hookEnv = workdir !== undefined ? { CLAUDE_PROJECT_DIR: workdir } : undefined
    for (const group of groups) {
      if (!matchesMatcher(group.matcher, matchQuery, DSH_HOOK_MATCHER_MODE)) continue
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn,
            point,
            dialect: DSH_HOOK_DIALECT,
            handlerId,
            ...group.matcher !== undefined ? { matcher: group.matcher } : {},
          })
        }
        const { output, durationMs } = await runHook(ctx.shell, hook, {
          payload,
          defaultTimeoutMs,
          ...hookEnv !== undefined ? { env: hookEnv } : {},
          ...workdir !== undefined ? { cwd: workdir } : {},
          signal: opts.signal,
          trailingNewline: true,
          expectedEventName: point,
        }, () => performance.now())
        outputs.push(output)
        if (output.updatedInput !== undefined) {
          ctx.logger.warn(`personal-hooks: ${point} hook requested updatedInput, which is not honored`)
        }
        if (output.systemMessage !== undefined) {
          ctx.logger.warn(`personal-hooks: ${point} hook emitted a systemMessage, which is not surfaced`)
        }
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  ctx.on('agent/created', async ({ agent, source, signal }) => {
    const ownerSignal = signal === undefined ? detached.signal : AbortSignal.any([signal, detached.signal])
    const run = runPoint('SessionStart', source, sessionStartPayload(agent, source), { agent, signal: ownerSignal })
      .then((merged) => {
        const extra = contextFrom(merged)
        if (extra) agent.inject(extra)
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`personal-hooks: SessionStart hook failed: ${String(error)}`)
      })
    detached.track(run)
    await run
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    if (messages.length === 0) return next()
    const content = messages.flatMap(message => message.content)
    const merged = await runPoint('UserPromptSubmit', '', promptPayload(agent, content), { agent, turn, signal })
    if (merged.decision === 'deny') return { kind: 'reject' }
    const downstream = await next()
    const ours = contextFrom(merged)
    if (!ours || downstream.kind !== 'enter') return downstream
    return { ...downstream, messages: [...downstream.messages, ours] }
  })

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await runPoint('PreToolUse', exec.name, preToolPayload(exec), {
      ...exec.agent !== undefined ? { agent: exec.agent } : {},
      ...turn !== undefined ? { turn } : {},
      signal: exec.signal,
    })
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
    return next()
  })

  ctx.on('tools/post-execute', async (exec: ToolExecution, result: ToolExecutionResult, next): Promise<PostToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await runPoint('PostToolUse', exec.name, postToolPayload(exec, result), {
      ...exec.agent !== undefined ? { agent: exec.agent } : {},
      ...turn !== undefined ? { turn } : {},
      signal: exec.signal,
    })
    const extra = contextFrom(merged)
    if (merged.decision === 'deny') {
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }],
        ...extra ? { additionalContexts: [extra] } : {},
      }
    }
    const downstream = await next()
    if (!extra) return downstream
    if (downstream.kind === 'block') {
      return { ...downstream, additionalContexts: prependContext(extra, downstream.additionalContexts) }
    }
    return { ...downstream, additionalContexts: prependContext(extra, downstream.additionalContexts) }
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const merged = await runPoint('Stop', '', stopPayload(agent), { agent, turn, signal })
    if (merged.decision === 'deny') {
      const text = merged.reason ?? 'continue: blocked by Stop hook'
      agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }))
    }
  })

  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    const session = child?.session ?? ctx.sessions.get(info.id as SessionId)
    const agent = child ?? (session !== undefined ? { session } as Agent : undefined)
    detached.track(runPoint(
      'SubagentStart',
      DSH_SUBAGENT_TYPE,
      subagentPayload('SubagentStart', info, child),
      { ...agent !== undefined ? { agent } : {}, signal: detached.signal },
    ).then((merged) => {
      const extra = contextFrom(merged)
      if (extra && child) child.inject(extra)
    }).catch((error: unknown) => {
      ctx.logger.warn(`personal-hooks: SubagentStart hook failed: ${String(error)}`)
    }))
  })

  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get('agents')?.get(info.id)
    subagentChildren.delete(info.runId)
    const session = child?.session ?? ctx.sessions.get(info.id as SessionId)
    const agent = child ?? (session !== undefined ? { session } as Agent : undefined)
    detached.track(runPoint(
      'SubagentStop',
      DSH_SUBAGENT_TYPE,
      subagentPayload('SubagentStop', info, child),
      { ...agent !== undefined ? { agent } : {}, signal: detached.signal },
    ))
  })
}
