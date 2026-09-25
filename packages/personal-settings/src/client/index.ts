/**
 * Client plugin: the review debate dock in `conversation.input.dock`, and the
 * 「窗口与评审」 page in `settings.section`.
 *
 * Both surfaces read the one `personal-review` settings namespace through one
 * controller, so the review-model list and the perspective are never two
 * sources of the same setting.
 * @module @psychiiii/dsh-three-window-settings/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ComposerBlocks } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@psychiiii/dsh-three-window-review/types'
import { DEFAULT_PERSPECTIVE } from '@psychiiii/dsh-three-window-review/prompts'
import { REVIEW_SETTINGS_ENTRY, type ReviewSettings } from '@psychiiii/dsh-three-window-review/reviewers'
import { ReviewDock } from './ReviewDock.tsx'
import type { ReviewDockInjected } from './ReviewDock.tsx'
import { createReviewComposerLock } from './composer-lock.ts'
import { ReviewSettingsController } from './settings-store.ts'
import { WorkspaceHooksController, type SessionCatalog } from './workspace-hooks-store.ts'
import { WindowReviewSection } from './WindowReviewSection.tsx'
import type { WindowReviewInjected } from './WindowReviewSection.tsx'
import { en, zh, type ReviewKey } from './locales.ts'

export type { ReviewKey } from './locales.ts'
export { ReviewDock } from './ReviewDock.tsx'
export type { ReviewDockInjected } from './ReviewDock.tsx'
export { ReviewSettingsController } from './settings-store.ts'
export { WindowReviewSection } from './WindowReviewSection.tsx'
export type { WindowReviewInjected, WindowReviewSectionProps } from './WindowReviewSection.tsx'
export { WorkspaceHooksController, joinHostPath, HOOKS_DIR_SEGMENTS, SELECTION_STORAGE_KEY } from './workspace-hooks-store.ts'
export type { HooksState, ProjectOption, SessionCatalog } from './workspace-hooks-store.ts'
export * from './hook-view.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Anonymous review dock copy. */
    personalReview: ReviewKey
  }
}

const NS = 'personalReview'

export const inject = [
  'slots', 'locale', 'remote', 'remote.session', 'remote.workspaceFiles',
  'sessions', 'configForms',
]

/**
 * Register the review dock and the 「窗口与评审」 settings page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'personal-review: dictionaries')
  const controller = new ReviewSettingsController(
    ctx.configForms.get<ReviewSettings>(REVIEW_SETTINGS_ENTRY), ctx)
  ctx.effect(() => () => { controller.dispose() }, 'personal-review: settings controller')
  const composerLock = createReviewComposerLock(
    () => (ctx.get('conversation') as { blocks?: ComposerBlocks } | undefined)?.blocks)
  ctx.effect(() => () => { composerLock.dispose() }, 'personal-review: review composer lock')
  const hooks = new WorkspaceHooksController(ctx, ctx.get('sessions') as unknown as SessionCatalog)
  ctx.effect(() => () => { hooks.dispose() }, 'personal-review: workspace hooks reader')
  const injected = (): ReviewDockInjected => ({
    hooks: {
      reviewSettings: controller.store,
      reviewCatalog: controller.catalog,
    },
    loadSettings: () => controller.load(),
    loadCatalog: () => controller.loadCatalog(),
    saveSettings: (rows, expectedRevision) => controller.save(rows, expectedRevision),
    lockComposer: (sessionId, locked, reason) => { composerLock.set(sessionId, locked, reason) },
  })
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'personal-review',
        order: 15,
        locale: NS,
        inject: injected,
      },
      ReviewDock,
    ))

  const sectionInjected = (): WindowReviewInjected => ({
    hooks: {
      reviewSettings: controller.store,
      windowHooks: hooks.store,
    },
    loadSettings: () => controller.load(),
    savePerspective: (perspective, expectedRevision) =>
      controller.savePerspective(perspective, expectedRevision),
    loadHooks: path => hooks.load(path),
    defaultPerspective: DEFAULT_PERSPECTIVE,
  })

  // Ordered between the agent-preset roster (20) and archived sessions (25):
  // the three windows are three presets, and this page configures what they
  // read and what the review seats are told to look at.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'personal-windows',
        order: 22,
        label: () => ctx.locale.bind(NS)('windows.nav'),
        locale: NS,
        inject: sectionInjected,
      },
      WindowReviewSection,
    ))
}
