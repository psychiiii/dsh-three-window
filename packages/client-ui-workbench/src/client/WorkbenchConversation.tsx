/** Conversation body for one workbench pane, instantiated via the shared factory. */
import type { ReactNode } from 'react'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CHAT_VIEW, type PaneViewsView } from './pane-view.ts'

/** What the workbench gives each pane's Conversation occupant. */
export interface WorkbenchConversationInjected {
  readonly hooks: {
    /** The View each pane Session shows. */
    readonly paneViews: HostObservable<PaneViewsView>
  }
}

/** Full composed props for one pane's Conversation occupant. */
export type WorkbenchConversationProps =
  & PropsRuntime<'workbench.conversation'>
  & PropsRenderFactories
  & PropsLocale<'workbench'>
  & InjectFace<WorkbenchConversationInjected>

/**
 * One stable View position per View id: the component identity must not
 * change between renders, or the Conversation body would remount each time.
 */
const fixedViews = new Map<string, (props: ConversationViewsProps) => ReactNode>()

/**
 * The factory's View position showing exactly `view`, as dsh's embedded
 * sidebar chat does, instead of the View dsh persisted for the Session.
 * @param view - a View id.
 * @returns the position component.
 */
function fixedView(view: string): (props: ConversationViewsProps) => ReactNode {
  let component = fixedViews.get(view)
  if (component === undefined) {
    component = props => <>{props.renderSlot('conversation.session', { view })}</>
    fixedViews.set(view, component)
  }
  return component
}

/**
 * Render the reusable Conversation factory inside an explicit SessionProvider,
 * on the View this pane chose (chat unless the pane header switched it).
 * @param props - session-maybe runtime, factory renderer, locale, and pane Views.
 * @returns the Conversation body for this pane.
 */
export function WorkbenchConversation({
  sessionId, useSession, useSessions, usePaneViews, renderFactorySlot,
}: WorkbenchConversationProps): ReactNode {
  const session = useSession(snapshot => snapshot)
  const view = usePaneViews(views => (sessionId === undefined ? CHAT_VIEW : views.viewOf(sessionId)))
  const openState = session?.openState
  const blank = session?.blank
  const summaryBlank = useSessions(state =>
    sessionId === undefined ? undefined : state.byId[sessionId]?.blank)
  const parentAvailabilityPending = session?.subagent?.address.mode === 'continuable'
    && session.subagent.parentAvailable === undefined
  const settling = sessionId !== undefined && (
    (blank === true && openState === 'loading' && summaryBlank !== true)
    || parentAvailabilityPending
  )
  const hero = sessionId === undefined
    || (blank === true && (openState === 'open' || summaryBlank === true))
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  return renderFactorySlot('conversation.content', {
    variant: 'embedded',
    phase,
    hero,
  }, {
    slots: { views: fixedView(view) },
  })
}
