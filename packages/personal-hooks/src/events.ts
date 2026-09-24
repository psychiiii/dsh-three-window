/**
 * Frozen hook-event names. The set is the union of this baseline's Claude Code
 * and Codex dialect support, and it is the only list this plugin consults.
 * @module @psychiiii/dsh-three-window-hooks/events
 */

/**
 * Unique source of hook event names for this runtime.
 *
 * Equals `CLAUDE_EVENTS` in `dsh-hooks-claude-code` (seven names). Codex
 * `CODEX_EVENTS` is the five-name subset that omits SubagentStart/SubagentStop.
 * Adding a name that neither dialect supports is a product failure.
 */
export const DSH_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const

/** One name from {@link DSH_HOOK_EVENTS}. */
export type DshHookEvent = (typeof DSH_HOOK_EVENTS)[number]

/** Membership test for {@link DSH_HOOK_EVENTS}. */
export const DSH_HOOK_EVENT_SET: ReadonlySet<string> = new Set(DSH_HOOK_EVENTS)

/**
 * Matcher mode this runtime uses with `dsh-hook-protocol`.
 *
 * Shared match-all sentinels are absent / `''` / `'*'`. Any other pattern is
 * Claude Code's literal-or-regex rule (word-and-pipe = exact alternatives).
 */
export const DSH_HOOK_MATCHER_MODE = 'claude-code' as const

/**
 * `hook/invoked.dialect` value. The protocol's closed union is
 * `'claude-code' | 'codex'`; this runtime is not either bridge, but the
 * invariant companion rejects any other string, and the event set matches
 * Claude Code's seven names.
 */
export const DSH_HOOK_DIALECT = 'claude-code' as const

/**
 * Matcher subject the SubagentStart/SubagentStop points use. The harness
 * subagent seam has no per-kind label; Claude Code's Task-tool default is
 * `general-purpose`, so a match-all matcher fires and a kind-specific one does
 * not.
 */
export const DSH_SUBAGENT_TYPE = 'general-purpose'

/** What the runtime does with a matched hook's merged outcome at one point. */
export interface DshHookEventEffects {
  /**
   * Whether `hookSpecificOutput.additionalContext` reaches the next model
   * request. False means the merged outcome's context is dropped: the hook
   * still runs, and its text goes nowhere.
   */
  readonly injectsAdditionalContext: boolean
  /**
   * What a blocking outcome (exit 2, or `hookSpecificOutput.permissionDecision`
   * of `deny`) does at this point. `none` means the decision is discarded.
   * `deny-tool` also honours `ask`.
   */
  readonly blocking: 'none' | 'reject-turn' | 'deny-tool' | 'block-result' | 'steer-continue'
  /**
   * What a group's `matcher` is compared against. `discarded` means the
   * config parser drops the field before dispatch, so the group always fires.
   */
  readonly matcherSubject: 'discarded' | 'tool-name' | 'session-source' | 'subagent-type'
}

/**
 * Per-event dispatch effects, as `apply()` in this package's entry implements
 * them. This table is the single place those facts are written down: the
 * runtime documentation and the settings page's hook translation both read it
 * instead of restating the dispatch.
 *
 * Read it as: the hook always runs when its group matches; these fields say
 * what the harness then does with what the hook returned.
 */
export const DSH_HOOK_EVENT_EFFECTS: Readonly<Record<DshHookEvent, DshHookEventEffects>> = {
  SessionStart: { injectsAdditionalContext: true, blocking: 'none', matcherSubject: 'session-source' },
  UserPromptSubmit: { injectsAdditionalContext: true, blocking: 'reject-turn', matcherSubject: 'discarded' },
  PreToolUse: { injectsAdditionalContext: false, blocking: 'deny-tool', matcherSubject: 'tool-name' },
  PostToolUse: { injectsAdditionalContext: true, blocking: 'block-result', matcherSubject: 'tool-name' },
  Stop: { injectsAdditionalContext: false, blocking: 'steer-continue', matcherSubject: 'discarded' },
  SubagentStart: { injectsAdditionalContext: true, blocking: 'none', matcherSubject: 'subagent-type' },
  SubagentStop: { injectsAdditionalContext: false, blocking: 'none', matcherSubject: 'subagent-type' },
}
