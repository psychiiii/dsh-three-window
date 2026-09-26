/**
 * Browser service `workspacePrompts`: the Workspace list's view of each
 * Workspace's turn prompt, and its one write.
 *
 * The Workspace list (`client-ui-workspace`) owns the menu entry, the marker
 * and the editor; this package owns the setting. The list reads the service
 * with `ctx.get('workspacePrompts')` against a structural type of its own, so
 * neither package imports the other, and a composition without this package
 * simply shows no entry.
 * @module @psychiiii/dsh-three-window-settings/client/workspace-prompts
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  WORKSPACE_PROMPT_MAX, estimateTurnTokens, normalizeWorkspaceRoot,
} from '@psychiiii/dsh-three-window-review/workspace-prompt'
import type { ReviewSettingsController, ReviewSettingsState } from './settings-store.ts'

/** What the Workspace list reads. */
export interface WorkspacePromptsSnapshot {
  /** True once the stored prompts are known. */
  readonly ready: boolean
  /** Whether this page may write settings (loopback pages only). */
  readonly writable: boolean
  /** Whether a write is in flight. */
  readonly saving: boolean
  /** The last refusal, verbatim, or null. */
  readonly error: string | null
  /** Longest prompt, in characters. */
  readonly limit: number
  /**
   * @param root - a Workspace root path, as the list reports it.
   * @returns that Workspace's prompt, or undefined.
   */
  promptOf(root: string): string | undefined
  /**
   * @param text - editor text.
   * @returns a rough per-turn token estimate for the editor's hint.
   */
  estimateTokens(text: string): number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-Workspace turn prompts; provided by the personal-settings browser half. */
    workspacePrompts: WorkspacePromptsService
  }
}

/** Snapshot over the shared settings controller. */
export class WorkspacePromptsService extends Service {
  private cachedFrom: ReviewSettingsState | undefined
  private cached: WorkspacePromptsSnapshot | undefined

  /**
   * @param ctx - client root context.
   * @param controller - the settings controller every surface of this package shares.
   */
  constructor(ctx: Context, private readonly controller: ReviewSettingsController) {
    super(ctx, 'workspacePrompts')
    // The Workspace list renders on every page, so the settings are followed from the start.
    void this.controller.load()
  }

  /** @returns the current view; identity changes only when the settings do. */
  getSnapshot(): WorkspacePromptsSnapshot {
    const state = this.controller.store.getSnapshot()
    if (this.cached !== undefined && this.cachedFrom === state) return this.cached
    const byRoot = new Map(state.workspacePrompts.map(entry => [entry.root, entry.prompt]))
    this.cachedFrom = state
    this.cached = {
      ready: state.status === 'ready' || state.status === 'saving' || state.status === 'error',
      writable: state.writable,
      saving: state.status === 'saving',
      error: state.status === 'error' ? state.error : null,
      limit: WORKSPACE_PROMPT_MAX,
      promptOf: root => byRoot.get(normalizeWorkspaceRoot(root)),
      estimateTokens: estimateTurnTokens,
    }
    return this.cached
  }

  /**
   * @param listener - called on every settings change.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    return this.controller.store.subscribe(listener)
  }

  /**
   * Store one Workspace's prompt; blank text removes it.
   * @param root - the Workspace root path.
   * @param prompt - the editor text.
   * @returns whether the write landed.
   */
  save(root: string, prompt: string): Promise<boolean> {
    return this.controller.saveWorkspacePrompt(root, prompt)
  }
}
