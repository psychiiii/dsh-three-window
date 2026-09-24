/**
 * Stdin JSON for command hooks. Field names follow the Claude Code hook input
 * schema for the seven supported events; this module does not import a bridge.
 * @module @psychiiii/dsh-three-window-hooks/payloads
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { DSH_SUBAGENT_TYPE, type DshHookEvent } from './events.ts'

/**
 * Flatten text blocks for hook payloads.
 * @param content - message or tool-result blocks.
 * @returns concatenated text.
 */
export function blocksToText(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Shared stdin fields.
 * @param agent - agent that raised the point, when known.
 * @param event - firing event name.
 * @returns session id, empty transcript path, cwd, and event name.
 */
export function basePayload(agent: Agent | undefined, event: DshHookEvent): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    transcript_path: '',
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}

/**
 * SessionStart stdin.
 * @param agent - newly created agent.
 * @param source - creation source string from `agent/created`.
 */
export function sessionStartPayload(agent: Agent, source: string): Record<string, unknown> {
  return { ...basePayload(agent, 'SessionStart'), source }
}

/**
 * UserPromptSubmit stdin.
 * @param agent - agent about to step.
 * @param content - claimed user-message blocks.
 */
export function promptPayload(agent: Agent, content: ContentBlock[]): Record<string, unknown> {
  return { ...basePayload(agent, 'UserPromptSubmit'), prompt: blocksToText(content) }
}

/**
 * PreToolUse stdin.
 * @param exec - pending tool call.
 */
export function preToolPayload(exec: ToolExecution): Record<string, unknown> {
  return {
    ...basePayload(exec.agent, 'PreToolUse'),
    tool_name: exec.name,
    tool_input: exec.arguments,
    tool_use_id: exec.callId,
  }
}

/**
 * PostToolUse stdin.
 * @param exec - tool call that ran.
 * @param result - normalized dispatch result.
 */
export function postToolPayload(exec: ToolExecution, result: ToolExecutionResult): Record<string, unknown> {
  return {
    ...basePayload(exec.agent, 'PostToolUse'),
    tool_name: exec.name,
    tool_input: exec.arguments,
    tool_use_id: exec.callId,
    tool_response: blocksToText(result.content),
  }
}

/**
 * Stop stdin. `stop_hook_active` stays false; this baseline has no loop guard.
 * @param agent - agent at the stopping boundary.
 */
export function stopPayload(agent: Agent): Record<string, unknown> {
  return { ...basePayload(agent, 'Stop'), stop_hook_active: false }
}

/**
 * SubagentStart/SubagentStop stdin.
 * @param event - which subagent point is firing.
 * @param info - published child identity.
 * @param child - live child agent, when still registered.
 */
export function subagentPayload(
  event: 'SubagentStart' | 'SubagentStop',
  info: { id: string },
  child: Agent | undefined,
): Record<string, unknown> {
  return {
    ...basePayload(child, event),
    agent_id: info.id,
    agent_type: DSH_SUBAGENT_TYPE,
    ...event === 'SubagentStop' ? { stop_hook_active: false } : {},
  }
}
