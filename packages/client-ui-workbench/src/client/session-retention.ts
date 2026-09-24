/**
 * Session retention seam shared by the workbench panes and the Workspace main
 * view. Both consumers take `ctx.sessionRetention`; neither reads
 * `sessions.retain` or `sessions.using` directly.
 *
 * {@link createSessionRetention} forwards to the Session Controller's
 * `retain()` / `using()`. A Controller without `retain()` predates the API and
 * is rejected with {@link UnsupportedHostError}; there is no fallback.
 * @module @psychiiii/dsh-three-window-workbench/session-retention
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ISessions, SessionReference, SessionRetainOptions, SessionTarget,
} from '@deepseek-ai/dsh-api-session-controller/client'

/**
 * API floor: the dsh release line whose client Session Controller first has
 * `retain()` / `using()` (measured absent on 0.1.5-rc.3, present from 0.1.6).
 * It is not the supported floor. What this plugin supports is the policy floor,
 * the installer's `HOST_FLOOR` (the newest published rc it was verified on),
 * which is newer; this value only names the release that added the API the
 * error below reports missing.
 */
export const SUPPORTED_HOST_FLOOR = '0.1.6-rc.1'

/** Retain and scoped-use operations over one Session Controller. */
export interface SessionRetention {
  /**
   * Retain a Session until the returned reference is released.
   * @param target - Session or subagent address.
   * @param options - reference source recorded by the Controller.
   * @returns the live reference.
   */
  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference
  /**
   * Retain a Session for the duration of `operation`.
   * @param target - Session or subagent address.
   * @param options - reference source recorded by the Controller.
   * @param operation - callback that uses the reference until it settles.
   * @returns the callback's settled value.
   */
  using<T>(
    target: SessionTarget,
    options: SessionRetainOptions,
    operation: (reference: SessionReference) => T | Promise<T>,
  ): Promise<T>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session retention seam; provided by {@link apply} in this module. */
    sessionRetention: SessionRetention
  }
}

/** Thrown when the page's Session Controller predates the supported floor. */
export class UnsupportedHostError extends Error {
  constructor() {
    super(
      'dsh-three-window: the Session Controller has no retain(), an API of dsh '
      + `${SUPPORTED_HOST_FLOOR} and later; this host predates it, and the plugin supports only newer `
      + 'releases (see its README). The browser cannot read the host version; run `dsh --version`.',
    )
    this.name = 'UnsupportedHostError'
  }
}

/**
 * Build retention over one Session Controller.
 * @param sessions - the page's Session Controller.
 * @returns retention forwarding to `retain()` / `using()`.
 * @throws {UnsupportedHostError} when the Controller has no `retain()`.
 */
export function createSessionRetention(sessions: ISessions): SessionRetention {
  if (typeof (sessions as Partial<ISessions>).retain !== 'function') throw new UnsupportedHostError()
  return {
    retain: (target, options) => sessions.retain(target, options),
    using: (target, options, operation) => sessions.using(target, options, operation),
  }
}

/** Cordis plugin name of the provider. */
export const name = 'session-retention'

/** The provider reads the page's Session Controller. */
export const inject = ['sessions']

/**
 * Provide `ctx.sessionRetention`. On an unsupported host this prints the
 * {@link UnsupportedHostError} to the browser console and rethrows it, so the
 * provider's fiber fails and the consumers that inject the service never start.
 * The console line is the only place the reason appears: the fiber failure
 * itself surfaces only as entries that did not activate.
 * @param ctx - client context with `sessions`.
 */
export function apply(ctx: Context): void {
  let retention: SessionRetention
  try {
    retention = createSessionRetention(ctx.sessions as ISessions)
  } catch (error) {
    console.error(error)
    throw error
  }
  ctx.provide('sessionRetention', retention)
}
