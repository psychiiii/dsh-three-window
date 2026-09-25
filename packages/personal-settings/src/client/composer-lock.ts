/**
 * Keep a review window's composer inert while no reviewer model is configured.
 *
 * dsh gives other plugins exactly one way to stop a Session's input:
 * `ctx.conversation.blocks`, one block slot per Session. The official model
 * picker writes the same slot — its reason when the Session's model cannot be
 * routed, `undefined` on every other change of its directory — so a block this
 * plugin raised would be cleared the next time the picker republishes. The
 * lock therefore watches the slot and raises its block again whenever it is
 * cleared while the lock is held, and on release it clears the slot only if
 * the block there is its own: a picker block is never removed by this code.
 *
 * Like the slot itself this is an affordance, not enforcement: `review_debate`
 * still refuses an empty reviewer table on the Host.
 * @module @psychiiii/dsh-three-window-settings/composer-lock
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerBlocks } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Holds or releases the reviewer lock on individual Sessions. */
export interface ReviewComposerLock {
  /**
   * Hold or release the lock on one Session's composer.
   * @param sessionId - the review window's Session.
   * @param locked - true to hold, false to release.
   * @param reason - placeholder the inert composer shows while held.
   */
  set(sessionId: string, locked: boolean, reason: string): void
  /** Release every lock this instance holds. */
  dispose(): void
}

/**
 * @param resolve - reads the composer block registry at the moment of use; it
 *   is undefined while the conversation service is absent, and nothing is
 *   locked then.
 * @returns the lock over that registry.
 */
export function createReviewComposerLock(resolve: () => ComposerBlocks | undefined): ReviewComposerLock {
  const held = new Map<string, { reason: string; stop: () => void; blocks: ComposerBlocks }>()

  const release = (sessionId: string): void => {
    const entry = held.get(sessionId)
    if (entry === undefined) return
    held.delete(sessionId)
    entry.stop()
    const store = entry.blocks.storeFor(sessionId as SessionId)
    if (store.getSnapshot()?.reason === entry.reason) entry.blocks.set(sessionId as SessionId, undefined)
  }

  return {
    set(sessionId, locked, reason) {
      if (!locked) { release(sessionId); return }
      const blocks = resolve()
      if (blocks === undefined) return
      const current = held.get(sessionId)
      if (current !== undefined && current.reason === reason) return
      if (current !== undefined) release(sessionId)
      const store = blocks.storeFor(sessionId as SessionId)
      const reassert = (): void => {
        if (held.get(sessionId)?.reason !== reason) return
        if (store.getSnapshot() === undefined) blocks.set(sessionId as SessionId, { reason })
      }
      // Re-raise after the writer that cleared the slot has finished notifying.
      const stop = store.subscribe(() => { queueMicrotask(reassert) })
      held.set(sessionId, { reason, stop, blocks })
      if (store.getSnapshot() === undefined) blocks.set(sessionId as SessionId, { reason })
    },
    dispose() {
      for (const sessionId of [...held.keys()]) release(sessionId)
    },
  }
}
