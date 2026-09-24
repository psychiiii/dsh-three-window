/**
 * Scoped tool deny for one agent-preset window: a least-privilege fence
 * over a window that must never mutate and must never spawn a mutating child.
 *
 * `tools.restrict()` cannot mask a scope's own registrations, and the review
 * preset registers write/edit/bash on its own standing mount, so the fence is
 * applied on each joined agent's context, where those names are inherited and
 * therefore restrictable. An ancestor restriction also covers nested scopes.
 *
 * The deny list is resolved at that same moment rather than at mount. A row's
 * `apply` runs while the sibling rows of its preset subtree are still
 * activating, so the standing view there is a partial snapshot — in one
 * reproducible window ordering it holds nothing at all — and a required name
 * read from it is absent for a composition that is in fact correct.
 * `mountPreset` awaits every enabled row before the agent binds to the
 * standing scope, so an `agent/created` listener reads the composition's
 * finished tool set. A required name missing there is a real configuration
 * error, and rejecting from the synchronous listener vetoes the agent's
 * publication, so the window fails loudly instead of running unfenced.
 *
 * A Session can also become a review window after publication: while it is
 * blank, `agentPresets.select` recomposes its agent onto the review preset,
 * which emits `agent-preset/selected` and never `agent/created`. The fence
 * therefore listens to both, and both go through {@link settleFence}, which
 * decides from the agent's current composition, not from the creation header
 * (a resumed Session that was switched earlier still carries the old header).
 * The same judgment lifts the fence when a blank Session is switched away from
 * the review preset, so it never outlives the composition it belongs to.
 *
 * Required `deny` names must all exist in the joined agent's view.
 * Platform-specific shells are separate preset rows with `disabled: !!js` so an
 * enabled row never lists a name the platform does not register. `optional` is
 * for names that may be absent on every platform; the review preset leaves it
 * empty.
 * @module @psychiiii/dsh-three-window/tool-deny
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'personal-web-tool-deny'

/** The registry this row reads each joined agent's view from and restricts. */
export const inject = ['tools']

/** Agent preset this fence applies to. */
export const REVIEW_PRESET = 'personal-review'

/** Plugin config: required and optional global/inherited tool names to remove. */
export interface Config {
  /** Tool names that must exist in a joined agent's view and are then restricted. */
  deny: string[]
  /**
   * Tool names restricted when present and skipped with a warning when absent.
   * Empty on the review preset: platform-absent shells use a disabled row
   * rather than this list.
   */
  optional: string[]
}

/** Schemastery configuration for the deny row. */
export const Config: z<Config> = z.object({
  deny: z.array(z.string()).default([]),
  optional: z.array(z.string()).default([]),
})

/** The agent fields this row reads; both events identify a full Agent. */
type FencedAgent = Pick<Agent, 'ctx'> & { session: { header: { agentPreset?: string } } }

/** The `agent/created` fields this row reads. */
interface AgentCreatedPayload {
  agent: FencedAgent
}

/**
 * Resolve the restrict list. Required names must all be present; optional
 * names that are absent are warned and dropped.
 * @param config - required and optional deny names.
 * @param present - tool names visible in the scope being fenced.
 * @param warn - logger for optional names that this deployment does not have.
 * @returns names to pass to `tools.restrict({ deny })`.
 * @throws when a required name is absent, or when nothing is left to restrict.
 */
export function resolveDenyList(
  config: Pick<Config, 'deny' | 'optional'>,
  present: ReadonlySet<string>,
  warn: (message: string) => void,
): string[] {
  const missingRequired = config.deny.filter(toolName => !present.has(toolName))
  if (missingRequired.length > 0) {
    throw new Error(
      `personal-web tool-deny: deny names not in this scope: ${formatNames(missingRequired)}`
      + `; configured deny: ${formatNames(config.deny)}`
      + `; present: ${formatNames([...present].sort())}`,
    )
  }
  const missingOptional = config.optional.filter(toolName => !present.has(toolName))
  if (missingOptional.length > 0) {
    warn(
      `personal-web tool-deny: optional tools not in this scope: ${formatNames(missingOptional)}`
      + `; configured deny: ${formatNames(config.deny)}`
      + `; present: ${formatNames([...present].sort())}`,
    )
  }
  const resolved = [
    ...config.deny,
    ...config.optional.filter(toolName => present.has(toolName)),
  ]
  if (resolved.length === 0) {
    throw new Error(
      `personal-web tool-deny: nothing to restrict; configured deny: ${formatNames(config.deny)}`
      + `; optional: ${formatNames(config.optional)}`
      + `; present: ${formatNames([...present].sort())}`,
    )
  }
  return resolved
}

/**
 * Reject a row that names nothing to restrict on any deployment.
 *
 * Both lists empty is decidable from the row's own config, so it fails at
 * mount instead of waiting for the first agent to join.
 * @param config - required and optional deny names.
 * @throws when `deny` and `optional` are both empty.
 */
export function assertRestrictsSomething(config: Pick<Config, 'deny' | 'optional'>): void {
  if (config.deny.length + config.optional.length > 0) return
  throw new Error(
    `personal-web tool-deny: nothing to restrict; configured deny: ${formatNames(config.deny)}`
    + `; optional: ${formatNames(config.optional)}`,
  )
}

function formatNames(names: readonly string[]): string {
  return names.length === 0 ? '(none)' : names.map(name => JSON.stringify(name)).join(', ')
}

/**
 * The preset an agent runs now. The registry's standing mount is the record;
 * the creation header is read only in compositions that mount no preset
 * registry, where it is the only one.
 * @param ctx - the row's context.
 * @param agent - the agent to classify.
 * @returns the current preset id, when known.
 */
export function currentPreset(ctx: Context, agent: FencedAgent): string | undefined {
  const registry = ctx.get('agentPresets')
  return registry === undefined ? agent.session.header.agentPreset : registry.composedPreset(agent.ctx)
}

/**
 * Bring one agent's fence in line with its preset: restrict a review agent
 * once, and lift the restriction of an agent that no longer runs the review
 * preset. Both listeners call this, so a created review window and a Session
 * switched to review are fenced by the same judgment against the same Config.
 * @param ctx - the row's context.
 * @param config - required and optional deny names.
 * @param fenced - restrictions this row holds, by agent.
 * @param agent - the agent to settle.
 * @param preset - its current preset.
 * @throws when a review agent has no scope, or a required name is absent from its view.
 */
export function settleFence(
  ctx: Context,
  config: Config,
  fenced: Map<FencedAgent['ctx'], () => void>,
  agent: FencedAgent,
  preset: string | undefined,
): void {
  const held = fenced.get(agent.ctx)
  if (preset !== REVIEW_PRESET) {
    if (held === undefined) return
    fenced.delete(agent.ctx)
    held()
    return
  }
  if (held !== undefined) return
  const target = agent.ctx
  const scope = scopeOf(target)
  if (scope === undefined) {
    throw new Error(
      'personal-web tool-deny: review agent has no scope to restrict'
      + `; configured deny: ${formatNames(config.deny)}`,
    )
  }
  const present = new Set(target.tools.schemas(scope).map(schema => schema.name))
  const deny = resolveDenyList(config, present, message => { ctx.logger.warn(message) })
  fenced.set(target, target.tools.restrict({ deny }))
}

/**
 * Fence every review agent: those published on the review preset
 * (`agent/created`, whose rejection vetoes publication) and those switched to
 * it while blank (`agent-preset/selected`, which cannot veto; a failure there
 * is logged by the emitter and the window stays unfenced only when its own
 * composition lacks a required name).
 *
 * The preset check is what keeps the fence off the other two windows: the
 * listeners are global, so they are offered every agent this host publishes,
 * and a chat or construct agent measured against a review deny list would veto
 * its own session.
 * @param ctx - the preset's standing context.
 * @param config - required and optional deny names.
 */
export function apply(ctx: Context, config: Config): void {
  assertRestrictsSomething(config)
  const fenced = new Map<FencedAgent['ctx'], () => void>()
  ctx.on('agent/created', (payload: AgentCreatedPayload) => {
    settleFence(ctx, config, fenced, payload.agent, currentPreset(ctx, payload.agent))
  }, { global: true })
  ctx.on('agent-preset/selected', (sessionId: SessionId, agentPreset: string) => {
    const agent = ctx.get('agents')?.get(sessionId)
    if (agent === undefined) return
    settleFence(ctx, config, fenced, agent, agentPreset)
  }, { global: true })
}
