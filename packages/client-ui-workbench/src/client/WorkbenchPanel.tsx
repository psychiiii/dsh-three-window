/** Three-pane Conversation occupant. Each pane pins one Session. */
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchInjected } from './service.ts'
import { WORKBENCH_PANE_ROLES } from './windows.ts'
import { PaneLanguageSelector } from './PaneLanguageSelector.tsx'
import type { PaneViewsView } from './pane-view.ts'
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
 * Unbound, missing, and not-ready panes show an explicit status. With no
 * Workspace at all the three panes give way to one empty state that points
 * at adding a Workspace: that is the first-run state, not a failure.
 * @param props - main-slot runtime, Conversation child, locale, and workbench inject.
 * @returns the three-pane occupant.
 */
/**
 * Switch between the Conversation Views dsh lists (chat, and the trajectory
 * while developer tools are on). dsh's own tabs live in the Session header,
 * which the panes do not render, so without this a pane moved to the
 * trajectory by a tool row's Inspect action could not come back.
 * @param props - the pane's Session, the Views, the selector, and the translator.
 * @returns the switch.
 */
function PaneViewSwitch({ sessionId, view, select, t }: {
  sessionId: string
  view: PaneViewsView
  select: (sessionId: string, view: string) => void
  t: WorkbenchPanelProps['t']
}): ReactNode {
  const active = view.viewOf(sessionId)
  return (
    <span className={css.viewSwitch} role="tablist" aria-label={t('view.aria')} data-workbench-view-switch="">
      {view.tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={tab.id === active ? `${css.viewTab ?? ''} ${css.viewTabActive ?? ''}` : css.viewTab}
          data-workbench-view={tab.id}
          onClick={(event) => {
            // The pane itself takes clicks to focus its window.
            event.stopPropagation()
            select(sessionId, tab.id)
          }}
        >
          {tab.label}
        </button>
      ))}
    </span>
  )
}

export function WorkbenchPanel({
  renderSlot, SessionProvider, useWorkbench, useSessions, usePaneLanguages, usePaneViews, saveOutputLanguage,
  selectPaneView, focus, t,
}: WorkbenchPanelProps): ReactNode {
  const panes = useWorkbench(snapshot => snapshot.panes)
  const bootstrapError = useWorkbench(snapshot => snapshot.bootstrapError)
  const focusedSessionId = useWorkbench(snapshot => snapshot.focusedSessionId)
  const noWorkspace = useWorkbench(snapshot => snapshot.noWorkspace)
  const languages = usePaneLanguages(view => view)
  const views = usePaneViews(view => view)
  const listed = useSessions(state => state.byId)
  if (noWorkspace && panes.every(pane => pane.sessionId === undefined)) {
    return (
      <div className={css.root} data-workbench-panes="0" data-workbench-empty="">
        <div className={css.empty}>
          <div className={css.emptyTitle}>{t('empty.title')}</div>
          <div className={css.emptyBody}>{t('empty.body')}</div>
        </div>
      </div>
    )
  }
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
              {state === 'bound' && sessionId !== undefined && views.tabs.length > 1 && (
                <PaneViewSwitch sessionId={sessionId} view={views} select={selectPaneView} t={t} />
              )}
              <PaneLanguageSelector index={index} view={languages} save={saveOutputLanguage} t={t} />
            </div>
            {body}
          </div>
        )
      })}
    </div>
  )
}
