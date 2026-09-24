/**
 * Review-debate argument checks that the parameter schema cannot express.
 * @module @psychiiii/dsh-three-window-review/args
 */

import { GROUPING_MODES, MAX_DEBATE_ROUNDS, type GroupingMode } from './types.ts'

/** Keys the parent agent must not pass; models and call options come from settings/config. */
export const FORBIDDEN_REVIEW_DEBATE_KEYS = [
  'model', 'provider', 'agentOptions',
  'maxTokens', 'temperature', 'callTimeoutMs',
  'timeoutMs', 'timeout', 'reasoningEffort', 'system', 'messages', 'tools',
] as const

/**
 * Reject tool arguments that try to choose a model or override the seat call.
 * @param raw - frozen `exec.arguments` object.
 */
export function assertNoModelOverride(raw: unknown): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
  const keys = Object.keys(raw)
  const hit = keys.filter(key => (FORBIDDEN_REVIEW_DEBATE_KEYS as readonly string[]).includes(key))
  if (hit.length > 0) {
    throw new Error(`review_debate does not accept ${hit.join(', ')}; reviewer models come from plugin settings`)
  }
}

/**
 * Accept a tool or config `maxRounds` in 1..{@link MAX_DEBATE_ROUNDS}. Out of
 * range is an error; the value is never truncated.
 * @param value - tool argument, or undefined to use `fallback`.
 * @param fallback - plugin config default, also range-checked.
 */
export function assertMaxRounds(value: unknown, fallback: number): number {
  const candidate = value === undefined ? fallback : value
  if (typeof candidate !== 'number' || !Number.isInteger(candidate)
    || candidate < 1 || candidate > MAX_DEBATE_ROUNDS) {
    throw new Error(
      `review_debate maxRounds must be an integer from 1 to ${String(MAX_DEBATE_ROUNDS)}, got ${JSON.stringify(candidate)}`,
    )
  }
  return candidate
}

/**
 * Accept a tool or config grouping mode. Unknown values error; they are never
 * coerced.
 * @param value - tool argument, or undefined to use `fallback`.
 * @param fallback - plugin config default.
 */
export function assertGrouping(value: unknown, fallback: GroupingMode): GroupingMode {
  const candidate = value === undefined ? fallback : value
  if (typeof candidate !== 'string' || !(GROUPING_MODES as readonly string[]).includes(candidate)) {
    throw new Error(
      `review_debate grouping must be ${GROUPING_MODES.map(item => JSON.stringify(item)).join(' or ')}, got ${JSON.stringify(candidate)}`,
    )
  }
  return candidate as GroupingMode
}

/** One configured reviewer. */
export interface ReviewerSpec {
  readonly role: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * Pick reviewers for one run.
 * @param reviewers - configured table, already 1–5 unique roles from settings.
 * @param roles - optional subset of roles.
 */
export function selectReviewers(
  reviewers: readonly ReviewerSpec[],
  roles: readonly string[] | undefined,
): ReviewerSpec[] {
  if (roles === undefined) return [...reviewers]
  if (roles.length === 0) throw new Error('review_debate roles must be a non-empty subset when provided')
  const byRole = new Map(reviewers.map(row => [row.role, row]))
  const selected: ReviewerSpec[] = []
  const seen = new Set<string>()
  for (const role of roles) {
    if (seen.has(role)) throw new Error(`review_debate roles repeats ${JSON.stringify(role)}`)
    seen.add(role)
    const row = byRole.get(role)
    if (row === undefined) {
      throw new Error(
        `review_debate role ${JSON.stringify(role)} is unknown (available: ${reviewers.map(item => item.role).join(', ')})`,
      )
    }
    selected.push(row)
  }
  return selected
}
