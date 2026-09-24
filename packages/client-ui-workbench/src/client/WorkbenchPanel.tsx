/** Three-pane Conversation occupant. Each pane pins one Session. */
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchInjected } from './service.ts'
import { WORKBENCH_PANE_ROLES } from './windows.ts'
import css from './WorkbenchPanel.module.css'

/** Full composed props for the workbench occupant. */
export type WorkbenchPanelProps =
  & PropsRuntime<'main'>
  & PropsRenderSlots<'workbench.conversation'>
  & PropsLocale<'workbench'>
  & InjectFace<WorkbenchInjected>

/**
 * Occupant for `main` key `conversation` (shadows the shipped single-session
 * panel). Each pane retains its Session and renders the Conversation factory.
 * Unbound, missing, and not-ready panes show an explicit status.
 * @param props - main-slot runtime, Conversation child, locale, and workbench inject.
 * @returns the three-pane occupant.
 */
export function WorkbenchPanel({
  renderSlot, SessionProvider, useWorkbench, useSessions, focus, t,
}: WorkbenchPanelProps): ReactNode {
  const panes = useWorkbench(snapshot => snapshot.panes)
  const bootstrapError = useWorkbench(snapshot => snapshot.bootstrapError)
  const focusedSessionId = useWorkbench(snapshot => snapshot.focusedSessionId)
  const listed = useSessions(state => state.byId)
  return (
    <div
      className={css.root}
      data-workbench-panes="3"
      data-workbench-bootstrap-error={bootstrapError ?? ''}
    >
      {panes.map((pane, index) => {
        const sessionId = pane.sessionId
        const listedRow = sessionId === undefined ? undefined : listed[sessionId as SessionId]
        const role = WORKBENCH_PANE_ROLES[index] ?? 'left'
        let body: ReactNode
        let state: 'unbound' | 'missing' | 'not-ready' | 'bound' | 'error'
        if (sessionId === undefined && bootstrapError !== undefined) {
          state = 'error'
          body = (
            <div className={css.status} aria-label={t('pane.bootstrapFailed', { message: bootstrapError })}>
              {t('pane.bootstrapFailed', { message: bootstrapError })}
            </div>
          )
        } else if (sessionId === undefined) {
          state = 'unbound'
          body = <div className={css.status} aria-label={t('pane.unbound')} />
        } else if (listedRow === undefined) {
          state = 'missing'
          body = <div className={css.status}>{t('pane.missing', { sessionId })}</div>
        } else if (pane.reference === undefined || !pane.ready || SessionProvider === undefined) {
          state = 'not-ready'
          body = <div className={css.status} aria-label={t('pane.notReady')}>{t('pane.notReady')}</div>
        } else {
          state = 'bound'
          const reference = pane.reference
          body = (
            <SessionProvider session={reference}>
              {renderSlot('workbench.conversation', {})}
            </SessionProvider>
          )
        }
        return (
          <div
            key={`${String(index)}:${sessionId ?? ''}`}
            className={sessionId !== undefined && sessionId === focusedSessionId ? `${css.pane ?? ''} ${css.paneFocused ?? ''}` : css.pane}
            data-workbench-pane-focused={sessionId !== undefined && sessionId === focusedSessionId ? 'true' : undefined}
            data-workbench-pane=""
            data-workbench-pane-index={String(index)}
            data-workbench-pane-role={role}
            data-workbench-pane-state={state}
            data-workbench-session={sessionId ?? ''}
            onClick={state === 'bound' && sessionId !== undefined
              ? () => { focus(sessionId) }
              : undefined}
          >
            <div className={css.chrome}>
              <span className={css.role}>{t(`pane.${role}`)}</span>
              {pane.title.length > 0 ? <span className={css.title}>{pane.title}</span> : null}
            </div>
            {body}
          </div>
        )
      })}
    </div>
  )
}
