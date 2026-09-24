/**
 * Debate report and projection types for anonymous multi-model review.
 * @module @psychiiii/dsh-three-window-review/types
 */

/** Inclusive round cap. No model output can raise or lower this. */
export const MAX_DEBATE_ROUNDS = 3

/** Inclusive character cap on seat JSON strings (evidence, claim, challenge evidence). */
export const MAX_SEAT_STRING_CHARS = 4000

/** Closed standing verdict a seat may return. */
export const VERDICT_VALUES = ['PASS', 'NEEDS-WORK', 'FAIL'] as const

/** One standing verdict. */
export type VerdictValue = (typeof VERDICT_VALUES)[number]

/** Closed challenge verdict a seat may return in rounds 2–3. */
export const CHALLENGE_VERDICTS = ['upheld', 'weakened', 'contradicted', 'needs-authority'] as const

/** One challenge verdict. */
export type ChallengeVerdict = (typeof CHALLENGE_VERDICTS)[number]

/** Controller terminal states. Seat JSON cannot invent another. */
export const TERMINAL_STATES = [
  'incomplete_review',
  'blocked_by_missing_decision',
  'changes_proposed',
  'clear_within_scope',
] as const

/** Overall terminal state produced by the controller. */
export type TerminalState = (typeof TERMINAL_STATES)[number]

/** Closed grouping modes for merging seat findings. */
export const GROUPING_MODES = ['evidence+claim', 'evidence'] as const

/** How findings are merged across seats. */
export type GroupingMode = (typeof GROUPING_MODES)[number]

/** Review-kind label keyed by distinct provider+model pairs, not by seat count. */
export const REVIEW_KINDS = ['single-model', 'multi-model'] as const

/** One review-kind label. */
export type ReviewKind = (typeof REVIEW_KINDS)[number]

/** One finding inside a seat JSON object. */
export interface ReviewFinding {
  /** Severity of this finding. */
  readonly severity: VerdictValue
  /** File+line, command output, or other concrete evidence. */
  readonly evidence: string
  /** What the seat claims about that evidence. */
  readonly claim: string
}

/** One challenge row targeting a labeled finding. */
export interface ChallengeRow {
  /** Label such as `F1`. */
  readonly target: string
  /** Challenge verdict for that label. */
  readonly verdict: ChallengeVerdict
  /** Evidence for the challenge. */
  readonly evidence: string
}

/** One wording of a claim under a merged finding, with the seats that used it. */
export interface FindingClaim {
  /** Exact trimmed claim text from a seat. */
  readonly claim: string
  /** Anonymous seat ids that used this wording, sorted. */
  readonly seats: readonly string[]
}

/** Finding after grouping, with anonymous seat ids only. */
export interface MergedFinding {
  /** Harshest severity among the grouped rows. */
  readonly severity: VerdictValue
  /** Representative evidence (first-seen trimmed original). */
  readonly evidence: string
  /** Distinct seats that raised this grouping key. */
  readonly seatCount: number
  /** Anonymous seat ids that raised this key, sorted. */
  readonly seats: readonly string[]
  /** Every distinct claim wording under this key. Never dropped. */
  readonly claims: readonly FindingClaim[]
}

/** Audit row: anonymous seat id mapped to the real route. Never enters prompts or report text. */
export interface SeatAudit {
  readonly seatId: string
  readonly provider: string
  readonly model: string
  readonly role: string
}

/** One seat's outcome inside a recorded round. */
export interface SeatRoundResult {
  readonly seatId: string
  readonly ok: boolean
  readonly error?: string
  readonly verdict?: VerdictValue
  readonly findingCount?: number
  readonly challenges?: readonly ChallengeRow[]
  readonly finish?: string
  readonly elapsedMs?: number
}

/** One controller round. */
export interface DebateRound {
  readonly round: number
  readonly changed: boolean
  readonly elapsedMs: number
  readonly seats: readonly SeatRoundResult[]
}

/** Prompt actually sent to one seat. Stored on presentation meta, not in report text. */
export interface DebatePromptRecord {
  readonly round: number
  readonly seatId: string
  readonly system: string
  readonly user: string
}

/** Controller output, `tool/result` meta, and the `personalReview` projection. */
export interface DebateReport {
  readonly debateId: string
  readonly baselineId: string
  readonly grouping: GroupingMode
  readonly terminal: TerminalState
  readonly converged: boolean
  readonly roundsUsed: number
  readonly reviewKind: ReviewKind
  readonly uniqueModelCount: number
  readonly findings: readonly MergedFinding[]
  readonly dissent: readonly MergedFinding[]
  readonly rounds: readonly DebateRound[]
  readonly report: string
  readonly seats: readonly SeatAudit[]
  readonly prompts: readonly DebatePromptRecord[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    personalReview: DebateReport | null
  }
  interface SessionProjectionMap {
    /**
     * Latest `review_debate` report on this Session, or null before the first
     * completed call. Folded from `tool/result` meta, not from model prose.
     */
    personalReview: DebateReport | null
  }
}
