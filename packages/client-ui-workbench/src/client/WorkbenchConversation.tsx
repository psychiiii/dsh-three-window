/** Conversation body for one workbench pane, instantiated via the shared factory. */
import type { ReactNode } from 'react'
import type {
  PropsLocale, PropsRenderFactories, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Full composed props for one pane's Conversation occupant. */
export type WorkbenchConversationProps =
  & PropsRuntime<'workbench.conversation'>
  & PropsRenderFactories
  & PropsLocale<'workbench'>

/**
 * Render the reusable Conversation factory inside an explicit SessionProvider.
 * @param props - session-maybe runtime, factory renderer, and locale.
 * @returns the Conversation body for this pane.
 */
export function WorkbenchConversation({
  sessionId, useSession, useSessions, renderFactorySlot,
}: WorkbenchConversationProps): ReactNode {
  const session = useSession(snapshot => snapshot)
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
  })
}
