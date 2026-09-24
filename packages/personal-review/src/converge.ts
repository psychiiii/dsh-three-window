/**
 * Pure round-change and terminal-state functions. Seat-declared fields are never read.
 *
 * Change is computed from the grouping key in use: a new key, a raised
 * severity, or a this-round `contradicted` challenge. `weakened` is recorded
 * on the round but is not a change — live two-seat auth.ts runs kept
 * weakening known findings every challenge round, which made a 3-round cap
 * structurally unreachable. `upheld` is not a change. Seat-declared
 * converged fields are not read.
 * @module @psychiiii/dsh-three-window-review/converge
 */

import { SEVERITY_RANK, mergedFindingKey } from './findings.ts'
import {
  MAX_DEBATE_ROUNDS,
  type ChallengeVerdict, type GroupingMode, type MergedFinding, type TerminalState, type VerdictValue,
} from './types.ts'

export { MAX_DEBATE_ROUNDS }

/** Finding-key snapshot plus this round's challenge verdicts. */
export interface ConclusionSnapshot {
  /** Finding key → current max severity. */
  readonly findings: ReadonlyMap<string, VerdictValue>
  /** This round's challenge verdicts (empty on round 1). */
  readonly challenges: readonly { readonly target: string; readonly verdict: ChallengeVerdict }[]
}

/**
 * Build a snapshot from the current union and this round's challenges.
 * @param findings - majority findings plus dissent.
 * @param grouping - merge mode that produced those findings.
 * @param challenges - this round's challenge rows; omit on round 1.
 */
export function snapshotConclusions(
  findings: readonly MergedFinding[],
  grouping: GroupingMode,
  challenges: readonly { readonly target: string; readonly verdict: ChallengeVerdict }[] = [],
): ConclusionSnapshot {
  const map = new Map<string, VerdictValue>()
  for (const finding of findings) {
    map.set(mergedFindingKey(finding, grouping), finding.severity)
  }
  return { findings: map, challenges }
}

/**
 * Whether the conclusion set changed. Change is only: a new grouping key, a
 * raised severity, or a this-round `contradicted` challenge. `weakened` and
 * `upheld` are not a change. Seat-declared converged fields are not read.
 * @param previous - snapshot after the prior round, or undefined before round 1.
 * @param current - snapshot after this round.
 */
export function conclusionsChanged(
  previous: ConclusionSnapshot | undefined,
  current: ConclusionSnapshot,
): boolean {
  if (previous === undefined) return current.findings.size > 0
  for (const [key, severity] of current.findings) {
    const prior = previous.findings.get(key)
    if (prior === undefined) return true
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[prior]) return true
  }
  for (const row of current.challenges) {
    if (row.verdict === 'contradicted') return true
  }
  return false
}

/** Inputs for {@link terminalState}. */
export interface TerminalInput {
  /** Neutral seat-failure reasons; any non-empty list yields `incomplete_review`. */
  readonly seatFailures: readonly string[]
  /** Majority findings plus dissent after the last round. */
  readonly findings: readonly MergedFinding[]
  /** Grouping mode used to key challenges. */
  readonly grouping: GroupingMode
  /**
   * Last-round challenge verdicts keyed by finding key. Absent keys mean the
   * finding was never challenged (round 1 stop).
   */
  readonly challengesByKey: ReadonlyMap<string, readonly ChallengeVerdict[]>
}

/**
 * Compute the controller terminal. Blocking findings are severity `FAIL`.
 * @param input - failures, unioned findings, and last-round challenges.
 */
export function terminalState(input: TerminalInput): TerminalState {
  if (input.seatFailures.length > 0) return 'incomplete_review'
  for (const finding of input.findings) {
    if (finding.severity !== 'FAIL') continue
    const verdicts = input.challengesByKey.get(mergedFindingKey(finding, input.grouping)) ?? []
    if (verdicts.some(item => item === 'contradicted' || item === 'needs-authority')) {
      return 'blocked_by_missing_decision'
    }
  }
  if (input.findings.length > 0) return 'changes_proposed'
  return 'clear_within_scope'
}

/**
 * Distinct provider+model count. Three seats on one model still count as 1.
 * @param seats - audit rows.
 */
export function uniqueModelCount(
  seats: readonly { readonly provider: string; readonly model: string }[],
): number {
  return new Set(seats.map(seat => `${seat.provider}\0${seat.model}`)).size
}
