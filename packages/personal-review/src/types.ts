/**
 * Debate report and projection types for anonymous multi-model review.
 * @module @psychiiii/dsh-three-window-review/types
 */

import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'

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

/**
 * Whether a finding answers what this review was asked about (`focus`) or is a
 * serious problem noticed outside it (`other`). Seats that omit it mean `focus`.
 */
export const REVIEW_SCOPES = ['focus', 'other'] as const

/** One finding scope. */
export type ReviewScope = (typeof REVIEW_SCOPES)[number]

/** Review-kind label keyed by distinct provider+model pairs, not by seat count. */
export const REVIEW_KINDS = ['single-model', 'multi-model'] as const

/** One review-kind label. */
export type ReviewKind = (typeof REVIEW_KINDS)[number]

/** One finding inside a seat JSON object. */
export interface ReviewFinding {
  /** Severity of this finding. */
  readonly severity: VerdictValue
  /** Where the problem is: a section, line, item, cell, timestamp, or short quote. */
  readonly evidence: string
  /** What the seat claims about that evidence. */
  readonly claim: string
  /** In the requested focus, or outside it; `focus` when the seat omitted it. */
  readonly scope: ReviewScope
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
  /** `focus` when any seat put it in the requested focus, else `other`. */
  readonly scope: ReviewScope
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

/**
 * Why the rounds ended: one seat's single round, conclusions stopped changing,
 * the round cap, or too few seats left after failures.
 */
export const STOP_REASONS = ['single-round', 'converged', 'round-cap', 'seat-failure'] as const

/** One stop reason. */
export type StopReason = (typeof STOP_REASONS)[number]

/**
 * Why a seat dropped out, as the user reads it: its answer was not in the
 * required format, it produced nothing for too long, it ran past the overall
 * limit, or the call itself failed.
 */
export const DROPOUT_CAUSES = ['format', 'idle', 'overall', 'call'] as const

/** One dropout cause. */
export type DropoutCause = (typeof DROPOUT_CAUSES)[number]

/** A seat that dropped out, and when and why. */
export interface SeatDropout {
  readonly seatId: string
  readonly round: number
  readonly error: string
  /** Absent on reports written before causes were recorded. */
  readonly cause?: DropoutCause
}

/**
 * Findings about one issue, as the grouping call sorted them. `members` index
 * `[...findings, ...dissent]`, ascending.
 */
export interface FindingGroup {
  /** The grouping model's few words for the issue; blank for a left-over finding. */
  readonly title: string
  readonly members: readonly number[]
  /** A finding the grouping answer did not mention, put back on its own. */
  readonly leftOver?: true
  /** Its findings name different material items (a hint to check the grouping). */
  readonly mixedSources?: true
}

/** How the grouping went. */
export interface GroupingInfo {
  /** `grouped`; `failed` (findings listed ungrouped); `not-needed` (fewer than two findings). */
  readonly status: 'grouped' | 'failed' | 'not-needed'
  /** Why it failed, in plain words. */
  readonly error?: string
  /** The route that grouped (the review window's model). Never in the coordinator's copy. */
  readonly provider?: string
  readonly model?: string
}

/** Prompt actually sent to one seat. Stored on presentation meta, not in report text. */
export interface DebatePromptRecord {
  readonly round: number
  readonly seatId: string
  readonly system: string
  readonly user: string
}

/** One material item as the manifest lists it. */
export interface MaterialManifestItem {
  /** `M1`, `M2`, … for included items; `-` for items that were not included. */
  readonly label: string
  /** Workspace-relative path, `git <spec>`, or the work report path. */
  readonly source: string
  /** Included, or why not. */
  readonly status: 'included' | 'not-text' | 'too-large' | 'over-limit'
  /** UTF-8 bytes included. */
  readonly bytes?: number
  /** Lines included. */
  readonly lines?: number
  /** Lines in the whole item, when it was cut to fit the size limit. */
  readonly totalLines?: number
  /** Why the coordinator picked it, in its words; absent when it gave none. */
  readonly why?: string
  /** For a version-control item: the files the change touches. */
  readonly files?: readonly string[]
}

/** What a review looks at, as the user and the seats both see it. */
export interface ReviewScopeText {
  /** This review's request (layer 3), as the coordinator passed it; blank for none. */
  readonly request: string
  /** The standing guidance in force (layer 2): the Workspace's, else the default; blank for none. */
  readonly guidance: string
  /** Where the guidance came from. */
  readonly guidanceSource: 'workspace' | 'default' | 'none'
}

/** Controller output, `tool/result` meta, and the `personalReview` projection. */
export interface DebateReport extends ReviewScopeText {
  readonly debateId: string
  readonly baselineId: string
  /** What was reviewed. */
  readonly manifest: readonly MaterialManifestItem[]
  readonly grouping: GroupingMode
  readonly terminal: TerminalState
  readonly converged: boolean
  readonly roundsUsed: number
  /** Why the rounds ended. */
  readonly stopReason: StopReason
  /** Seats that failed and left the later rounds. */
  readonly dropouts: readonly SeatDropout[]
  readonly reviewKind: ReviewKind
  readonly uniqueModelCount: number
  readonly findings: readonly MergedFinding[]
  readonly dissent: readonly MergedFinding[]
  readonly rounds: readonly DebateRound[]
  /** The report text the coordinator reads (Markdown, see `report-markdown.ts`). */
  readonly report: string
  readonly seats: readonly SeatAudit[]
  readonly prompts: readonly DebatePromptRecord[]
  /** The findings sorted by issue; absent when grouping failed or on reports from earlier builds. */
  readonly groups?: readonly FindingGroup[]
  /** How the grouping by issue went; absent on reports from earlier builds. */
  readonly issueGrouping?: GroupingInfo
  /**
   * The review window's output language when the report was written (blank
   * for none, which writes English); absent on reports from earlier builds.
   */
  readonly language?: string
}

/**
 * One progress record `review_debate` appends to the Session log while it
 * runs: once when the user starts the review, then after each round. Log-only
 * (no surface operation), so it never enters the model's history.
 */
export interface ReviewProgressEvent {
  /** The `review_debate` call this belongs to. */
  readonly callId: string
  readonly phase: 'started' | 'round-done'
  /** The round that is starting (`started`) or has just ended (`round-done`). */
  readonly round: number
  readonly maxRounds: number
  /** Seats that started the review. */
  readonly seats: number
  /** Seats still in after this record. */
  readonly remaining: number
  /** Seats that dropped out in this round (`round-done` only). */
  readonly dropped: readonly SeatDropout[]
  /** Whether another round follows (`round-done` only). */
  readonly continuing: boolean
}

/** How the latest review run went, as the review panel shows it. */
export const RUN_STATUSES = ['running', 'complete', 'partial', 'failed', 'cancelled'] as const

/** One run status. */
export type RunStatus = (typeof RUN_STATUSES)[number]

/** The latest `review_debate` run on a Session. */
export interface ReviewRun {
  readonly callId: string
  readonly status: RunStatus
  /** The round running now, or the last one that ran. */
  readonly round: number
  readonly maxRounds: number
  readonly seats: number
  readonly remaining: number
  /** The last round that ended, if any. */
  readonly roundDone?: number
  /** Whether another round follows the last one that ended. */
  readonly continuing: boolean
  /** Every seat that dropped out so far. */
  readonly dropped: readonly SeatDropout[]
}

/** What the review panel reads: the latest run, its report, and the finding ids the coordinator cited. */
export interface ReviewPanelState {
  readonly run: ReviewRun | null
  /** The latest run's report without its seat prompts; null when it produced none (cancelled, failed early, or none yet). */
  readonly report: Omit<DebateReport, 'prompts'> | null
  /** Finding ids of `report` that the coordinator's reply after it mentioned, in first-mention order. */
  readonly cited: readonly string[]
  /** Whether the coordinator's reply to `report` may still add citations (its turn has not ended). */
  readonly citing: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** `review_debate` progress, see {@link ReviewProgressEvent}. Log-only. */
    'personal-review/progress': ReviewProgressEvent
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    personalReview: ReviewPanelState
  }
  interface SessionProjectionMap {
    /**
     * The latest `review_debate` run on this Session: its progress while it
     * runs, how it ended, its report, and which of the report's findings the
     * coordinator cited. Folded from `personal-review/progress`, `tool/result`
     * meta, and the coordinator's reply text — never from model judgement.
     */
    personalReview: ReviewPanelState
  }
}
