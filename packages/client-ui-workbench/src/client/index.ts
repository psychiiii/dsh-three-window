/**
 * Three side-by-side Conversation windows over the keyed `main` seat. Each
 * window is an ordinary Session retained through `ctx.sessionRetention`.
 * @module @psychiiii/dsh-three-window-workbench
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  resolveClientWorkbenchConfig, WORKBENCH_WINDOW_COUNT,
  type WorkbenchBootPayload,
} from '../config.ts'
import { watchWorkbenchPanes } from './bootstrap.ts'
import { createFocusStore } from './focus-store.ts'
import { createWindowHistoryStore } from './window-history.ts'
import { WorkbenchPanel } from './WorkbenchPanel.tsx'
import { WorkbenchConversation } from './WorkbenchConversation.tsx'
import { Workbench, type WorkbenchInjected } from './service.ts'
import { en, NS, zh, type WorkbenchKey } from './locales.ts'

export const inject = ['sessions', 'sessionRetention', 'slots', 'locale', 'remote', 'remote.session']

export {
  Config, resolveClientWorkbenchConfig, resolveWorkbenchConfig, WORKBENCH_PERMISSIONS,
  WORKBENCH_WINDOW_COUNT,
  type ResolvedWorkbenchConfig, type WorkbenchBootPayload, type WorkbenchPermission,
  type WorkbenchReuseStrategy, type WorkbenchWindowConfig,
} from '../config.ts'
export {
  normalizeProjectPath, PROJECT_ROOT_EMPTY, PROJECT_ROOT_IS_HOST_HOME, PROJECT_ROOT_MISSING,
  resolveProjectRoot, sameProjectPath, selectExistingWorkspace,
  type ProjectRootRequest, type ProjectRootSource, type ProjectRootSpec,
  type ProjectRootWorkspace,
} from '../project-root.ts'
export type { WorkbenchPaneRole, WorkbenchWindow } from './windows.ts'
export type {
  WorkbenchInjected, WorkbenchLayout, WorkbenchLimitAction, WorkbenchLimitPrompt, WorkbenchPaneIndex,
  WorkbenchPaneSnapshot, WorkbenchRefusalCode, WorkbenchSnapshot, WorkbenchWindowOutcome, WorkbenchWindowRole,
} from './service.ts'
export { projectedPreset, WorkbenchKindFullError, WorkbenchRefusal } from './service.ts'
export {
  WORKBENCH_KIND_LIMIT, WORKBENCH_PAST_LIMIT, WORKBENCH_WINDOWS_KEY,
  pruneWindowHistory, readWindowHistory,
  type WindowHistoryState, type WorkspaceWindowRecord,
} from './window-history.ts'
export * as SessionRetentionProvider from './session-retention.ts'
export {
  createSessionRetention, SUPPORTED_HOST_FLOOR, UnsupportedHostError,
  type SessionRetention,
} from './session-retention.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Conversation body pinned by a workbench pane. Declared as a child of
     * the shadowed `main` / `conversation` occupant.
     */
    'workbench.conversation': {
      kind: 'single'
      scope: 'session-maybe'
    }
  }

  interface LocaleNamespaceMap {
    /** Three-pane Conversation occupant copy. */
    workbench: WorkbenchKey
  }
}

/**
 * Client plugin body: register the workbench service and shadow the main
 * Conversation occupant with the three-pane panel.
 * @param ctx - client root context.
 * @param config - apply argument, else the Host-injected page global, else empty windows.
 */
export function apply(ctx: ClientContext, config?: WorkbenchBootPayload): void {
  const resolved = resolveClientWorkbenchConfig(config)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workbench: dictionaries')
  const workbench = new Workbench(ctx, resolved, createFocusStore(), createWindowHistoryStore())
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({
      name: 'main',
      key: 'conversation',
      priority: -1,
      locale: NS,
      children: {
        'workbench.conversation': { kind: 'single', scope: 'session-maybe' },
      },
      inject: (): WorkbenchInjected => ({
        hooks: { workbench },
        focus: (sessionId) => { workbench.focus(sessionId) },
        bind: (windows, workspaceId) => { workbench.bind(windows, workspaceId) },
        swap: (fromIndex, toIndex) => { workbench.swap(fromIndex, toIndex) },
      }),
    }, WorkbenchPanel)
    yield ctx.slots.register({
      name: 'workbench.conversation',
      locale: NS,
    }, WorkbenchConversation)
  })
  if (resolved.windows.length !== WORKBENCH_WINDOW_COUNT) return
  ctx.inject(['workspaces', 'remote', 'remote.agentPresets', 'remote.session'], (ready) => {
    ready.effect(
      () => workbench.attach(ready),
      'ui-workbench: attach session create',
    )
    ready.effect(
      () => watchWorkbenchPanes(ready, workbench, resolved),
      'ui-workbench: pane bootstrap',
    )
  })
}
