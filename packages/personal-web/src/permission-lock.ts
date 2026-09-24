/**
 * Review-window permission lock: a scoped `/permission` shadow plus a
 * sandbox-mode pin. The official command is the web client's write path;
 * `permissionPresets.set` and any other append of `sandbox/mode` still have
 * to lose, so a post-commit listener rewrites a wider mode back to
 * `read-only`. The rewrite is not a loop: a `read-only` event returns.
 *
 * A Session switched to the review preset while blank (`agentPresets.select`,
 * which emits `agent-preset/selected`) was created under another preset and
 * kept its sandbox mode, so the switch itself pins `read-only` — the same
 * write `/permission read-only` performs. Whether a Session is a review window
 * is read from its agent's current composition, never from the creation
 * header, which still names the preset the Session started with.
 *
 * Both listeners run inside the publication of the event they react to, and a
 * Session refuses an append that reenters its own publication ("session append
 * cannot reenter while another append is being published", measured on
 * 0.1.7-rc.1). They therefore queue their `read-only` write as a microtask,
 * which runs once that publication has finished.
 * @module @psychiiii/dsh-three-window/permission-lock
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-commands'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'personal-web-permission-lock'

/** Command registry and the policy fold this lock pins. */
export const inject = ['commands', 'sandboxPolicy']

/** Agent preset this lock applies to. */
export const REVIEW_PRESET = 'personal-review'

/** Error text when the review window refuses a wider preset. */
export const REVIEW_PERMISSION_LOCK_MESSAGE =
  '审核窗的权限被锁定为 read-only，如需提权请到施工窗'

/**
 * Direct `/permission` result for the review window. `read-only` is
 * idempotent; every other argument is an error.
 * @param rawInput - text after `/permission`.
 * @param currentPreset - `permissionPresets.current(session)`.
 */
export function reviewPermissionResult(rawInput: string, currentPreset: string): CommandResult {
  const name = rawInput.trim()
  if (name === '') {
    return { kind: 'success', text: `current preset ${currentPreset} (locked: read-only)` }
  }
  if (name === 'read-only') {
    return { kind: 'success', text: 'preset read-only' }
  }
  return { kind: 'error', text: REVIEW_PERMISSION_LOCK_MESSAGE }
}

/**
 * Whether `session` runs the review preset now: its live agent's standing
 * composition, or the creation header when no agent or preset registry is
 * mounted.
 * @param ctx - the lock's context.
 * @param session - the Session to classify.
 * @returns true for a review window.
 */
export function isReviewSession(ctx: Context, session: Session): boolean {
  const agent = ctx.get('agents')?.get(session.id)
  const registry = ctx.get('agentPresets')
  const preset = agent === undefined || registry === undefined
    ? session.header.agentPreset
    : registry.composedPreset(agent.ctx)
  return preset === REVIEW_PRESET
}

/**
 * Put a review Session's sandbox mode at `read-only` unless it already is;
 * `/permission read-only` and the switch to the review preset both call this.
 * @param ctx - the lock's context.
 * @param session - the review Session.
 */
export function pinReadOnly(ctx: Context, session: Session): void {
  const mode = ctx.sandboxPolicy.resolve({ session }).mode
  if (mode !== 'read-only') setSandboxMode(session, 'read-only')
}

/**
 * Pin `read-only` after the publication in progress on `session` finishes.
 * A failure is logged: the listener that queued it has already returned.
 * @param ctx - the lock's context.
 * @param session - the review Session.
 * @param stillReview - checked again when the write runs, so a Session
 *   switched away in the meantime is left alone.
 */
export function pinReadOnlyAfterPublication(ctx: Context, session: Session, stillReview: () => boolean): void {
  queueMicrotask(() => {
    try {
      if (stillReview()) pinReadOnly(ctx, session)
    } catch (error: unknown) {
      ctx.logger.warn(`personal-web permission-lock: could not pin read-only on ${session.id}: ${String(error)}`)
    }
  })
}

/**
 * Register the scoped `/permission` shadow, pin review-session sandbox mode
 * to `read-only`, and pin it when a blank Session is switched to the review
 * preset.
 * @param ctx - the review preset's standing context.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-three-window/permission-lock'),
    name: 'permission',
    description: 'Show the review-window permission lock (read-only)',
    input: { hint: '<preset>' },
    handler: ({ agent, rawInput }) => {
      const presets = ctx.get('permissionPresets')
      const current = presets === undefined ? 'read-only' : presets.current(agent.session)
      const result = reviewPermissionResult(rawInput, current)
      if (result.kind === 'success' && rawInput.trim() === 'read-only') pinReadOnly(ctx, agent.session)
      return result
    },
  })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'sandbox/mode') return
    if (event.data.mode === 'read-only') return
    if (!isReviewSession(ctx, session)) return
    pinReadOnlyAfterPublication(ctx, session, () => isReviewSession(ctx, session))
  }, { global: true })

  ctx.on('agent-preset/selected', (sessionId: SessionId, agentPreset: string) => {
    if (agentPreset !== REVIEW_PRESET) return
    const session = ctx.get('agents')?.get(sessionId)?.session
    if (session === undefined) return
    pinReadOnlyAfterPublication(ctx, session, () => isReviewSession(ctx, session))
  }, { global: true })
}
