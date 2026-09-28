/**
 * Debate controller: concurrent seats, mechanical rounds, one in-memory report.
 * @module @psychiiii/dsh-three-window-review/debate
 */

import type { ResolvedMaterial } from './material.ts'
import type { SeatCompleteRequest, SeatTextResult } from './complete.ts'
import {
  conclusionsChanged, snapshotConclusions, terminalState, uniqueModelCount,
} from './converge.ts'
import { labelFindings, mergeFindings, mergedFindingKey, type LabeledFinding } from './findings.ts'
import { parseSeatJson, type ParsedChallenge, type ParsedInitial } from './parse.ts'
import { buildChallengeUserPrompt, buildInitialUserPrompt, DEBATE_SYSTEM_PROMPT } from './prompts.ts'
import { GROUPING_SYSTEM_PROMPT, groupFindings, type GroupingCompleter } from './grouping.ts'
import { renderReportMarkdown, type ReportSource } from './report-markdown.ts'
import type {
  ChallengeVerdict, DebatePromptRecord, DebateReport, DebateRound, DropoutCause, GroupingMode,
  MergedFinding, ReviewFinding, ReviewProgressEvent, ReviewScopeText, SeatAudit, SeatDropout, SeatRoundResult, StopReason,
} from './types.ts'
import { MAX_DEBATE_ROUNDS } from './types.ts'

/** One anonymous seat bound to a real route that never enters the prompt. */
export interface DebateSeat {
  readonly seatId: string
  readonly role: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Injected seat completer. Production uses {@link completeSeat}. */
export type DebateCompleter = (request: SeatCompleteRequest) => Promise<SeatTextResult>

/** Inputs for {@link runDebate}. */
export interface DebateInput {
  readonly debateId: string
  /** The frozen material every seat receives. */
  readonly material: ResolvedMaterial
  readonly seats: readonly DebateSeat[]
  readonly maxRounds: number
  readonly maxParallel: number
  readonly maxTokens: number
  /** Overall cap on one seat call, however much it is producing. */
  readonly timeoutMs: number
  /** Abort a seat only after this long without any output; `0` never. */
  readonly idleTimeoutMs?: number
  readonly grouping: GroupingMode
  /** The standing guidance (layer 2) and this review's request (layer 3), with the guidance's source. */
  readonly scope: ReviewScopeText
  /**
   * The review window's output language tag. Blank or absent adds nothing;
   * a tag adds one fixed line about the natural-language fields.
   */
  readonly outputLanguage?: string
  readonly signal: AbortSignal
  readonly complete: DebateCompleter
  /**
   * The grouping call after the rounds (`grouping.ts`); absent, the findings
   * are listed ungrouped. Seats never see it and it sees no seat.
   */
  readonly groupIssues?: GroupingCompleter
  /** The route of `groupIssues`, recorded in the report (the dialog shows it; the coordinator's copy does not). */
  readonly groupingRoute?: { readonly provider: string; readonly model: string }
  /** Told when the review starts and after each round; the tool records it for the review panel. */
  readonly onProgress?: (event: Omit<ReviewProgressEvent, 'callId'>) => void
}

interface SeatOutcome {
  readonly seatId: string
  readonly ok: boolean
  readonly error?: string
  readonly cause?: DropoutCause
  readonly finish?: string
  readonly elapsedMs: number
  readonly value?: ParsedInitial | ParsedChallenge
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index] as T, index)
    }
  }
  const n = Math.min(Math.max(1, limit), items.length)
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

function toRoundSeat(row: SeatOutcome): SeatRoundResult {
  if (!row.ok || row.value === undefined) {
    return {
      seatId: row.seatId,
      ok: false,
      elapsedMs: row.elapsedMs,
      ...row.error !== undefined ? { error: row.error } : {},
      ...row.finish !== undefined ? { finish: row.finish } : {},
    }
  }
  return {
    seatId: row.seatId,
    ok: true,
    verdict: row.value.verdict,
    findingCount: row.value.findings.length,
    elapsedMs: row.elapsedMs,
    ...row.finish !== undefined ? { finish: row.finish } : {},
    ...row.value.kind === 'challenge' ? { challenges: row.value.verdicts } : {},
  }
}

function challengesByFindingKey(
  labeled: readonly LabeledFinding[],
  grouping: GroupingMode,
  outcomes: readonly SeatOutcome[],
): Map<string, ChallengeVerdict[]> {
  const labelToKey = new Map(labeled.map(item => [item.label, mergedFindingKey(item, grouping)]))
  const map = new Map<string, ChallengeVerdict[]>()
  for (const row of outcomes) {
    if (!row.ok || row.value?.kind !== 'challenge') continue
    for (const challenge of row.value.verdicts) {
      const key = labelToKey.get(challenge.target)
      if (key === undefined) continue
      const list = map.get(key)
      if (list === undefined) map.set(key, [challenge.verdict])
      else list.push(challenge.verdict)
    }
  }
  return map
}

/**
 * Run at most {@link MAX_DEBATE_ROUNDS} concurrent seat rounds and return one report.
 * Seats cannot see each other: each call is a tool-less `llm.stream()` with
 * de-identified claim text only.
 * @param input - seats, baseline, caps, grouping, and completer.
 */
export async function runDebate(input: DebateInput): Promise<DebateReport> {
  if (!Number.isInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > MAX_DEBATE_ROUNDS) {
    throw new Error(
      `review_debate maxRounds must be an integer from 1 to ${String(MAX_DEBATE_ROUNDS)}, got ${JSON.stringify(input.maxRounds)}`,
    )
  }
  const grouping = input.grouping
  const audit: SeatAudit[] = input.seats.map(seat => ({
    seatId: seat.seatId,
    provider: seat.provider,
    model: seat.model,
    role: seat.role,
  }))
  const modelCount = uniqueModelCount(audit)
  const reviewKind = modelCount <= 1 ? 'single-model' : 'multi-model'
  // One seat is an ordinary single-model review: nobody else can corroborate
  // or challenge its findings, so it runs one round and every finding it
  // raises is a finding of the review, not dissent.
  const singleSeat = input.seats.length === 1
  const roundLimit = singleSeat ? 1 : input.maxRounds
  const prompts: DebatePromptRecord[] = []
  const rounds: DebateRound[] = []
  const collected: { seatId: string; findings: readonly ReviewFinding[] }[] = []
  let labeled: LabeledFinding[] = []
  let previous = snapshotConclusions([], grouping)
  let lastChallenges = new Map<string, ChallengeVerdict[]>()
  const dropouts: SeatDropout[] = []
  // A failed seat leaves the later rounds; the review goes on while enough
  // seats remain to corroborate and challenge each other (two, or the one
  // seat of a single-seat review).
  let active = [...input.seats]
  let stopReason: StopReason = singleSeat ? 'single-round' : 'round-cap'
  let stoppedShort = false
  let converged = false

  for (let round = 1; round <= roundLimit; round += 1) {
    const mode = round === 1 ? 'initial' : 'challenge'
    if (round === 1) {
      input.onProgress?.({
        phase: 'started', round, maxRounds: roundLimit, seats: input.seats.length,
        remaining: active.length, dropped: [], continuing: true,
      })
    }
    const promptLabeled = labeled
    const roundPrompts: DebatePromptRecord[] = new Array(active.length)
    const roundStarted = Date.now()
    const roundSeats = active
    const outcomes = await mapPool(roundSeats, input.maxParallel, async (seat, index) => {
      const ask = { guidance: input.scope.guidance, request: input.scope.request }
      const user = mode === 'initial'
        ? buildInitialUserPrompt(seat.role, input.material, ask, input.outputLanguage)
        : buildChallengeUserPrompt(seat.role, input.material, promptLabeled, ask, input.outputLanguage)
      roundPrompts[index] = {
        round,
        seatId: seat.seatId,
        system: DEBATE_SYSTEM_PROMPT,
        user,
      }
      const timeout = AbortSignal.timeout(input.timeoutMs)
      const signal = AbortSignal.any([input.signal, timeout])
      const request: SeatCompleteRequest = {
        seatId: seat.seatId,
        provider: seat.provider,
        model: seat.model,
        system: DEBATE_SYSTEM_PROMPT,
        user,
        maxTokens: input.maxTokens,
        signal,
        ...input.idleTimeoutMs !== undefined ? { idleTimeoutMs: input.idleTimeoutMs } : {},
        ...seat.reasoningEffort !== undefined ? { reasoningEffort: seat.reasoningEffort } : {},
      }
      const started = Date.now()
      const text = await input.complete(request)
      const elapsedMs = Date.now() - started
      if (!text.ok) {
        const overall = timeout.aborted && !input.signal.aborted
        return {
          seatId: seat.seatId,
          ok: false,
          error: overall ? `seat reached the overall limit of ${String(Math.round(input.timeoutMs / 60_000))} min` : text.error,
          cause: overall ? 'overall' : text.idle === true ? 'idle' : 'call',
          elapsedMs,
          ...text.finish !== undefined ? { finish: text.finish } : {},
        } satisfies SeatOutcome
      }
      const parsed = parseSeatJson(text.text, {
        mode,
        baselineId: input.material.id,
        ...mode === 'challenge' ? { expectedTargets: promptLabeled.map(item => item.label) } : {},
      })
      if (!parsed.ok) {
        return {
          seatId: seat.seatId,
          ok: false,
          error: parsed.error,
          cause: 'format',
          elapsedMs,
          finish: text.finish,
        } satisfies SeatOutcome
      }
      return {
        seatId: seat.seatId,
        ok: true,
        value: parsed.value,
        elapsedMs,
        finish: text.finish,
      } satisfies SeatOutcome
    })
    prompts.push(...roundPrompts)

    const droppedNow: SeatDropout[] = []
    for (const row of outcomes) {
      if (!row.ok) {
        droppedNow.push({ seatId: row.seatId, round, error: row.error ?? 'seat failed', cause: row.cause ?? 'call' })
      }
      else if (row.value !== undefined) {
        collected.push({ seatId: row.seatId, findings: row.value.findings })
      }
    }
    dropouts.push(...droppedNow)
    active = roundSeats.filter(seat => outcomes.some(row => row.seatId === seat.seatId && row.ok))

    const split = mergeFindings(collected, grouping)
    const allFindings = [...split.findings, ...split.dissent]
    const thisChallenges = mode === 'challenge'
      ? outcomes.flatMap(row => row.value?.kind === 'challenge' ? row.value.verdicts : [])
      : []
    const current = snapshotConclusions(allFindings, grouping, thisChallenges)
    const changed = conclusionsChanged(
      round === 1 ? undefined : previous,
      current,
    )
    rounds.push({
      round,
      changed,
      elapsedMs: Date.now() - roundStarted,
      seats: outcomes.map(toRoundSeat),
    })
    previous = current
    lastChallenges = mode === 'challenge'
      ? challengesByFindingKey(promptLabeled, grouping, outcomes)
      : new Map()
    labeled = labelFindings(split.findings, split.dissent)

    const tooFew = active.length < (singleSeat ? 1 : 2)
    const continuing = !tooFew && changed && round < roundLimit
    input.onProgress?.({
      phase: 'round-done', round, maxRounds: roundLimit, seats: input.seats.length,
      remaining: active.length, dropped: droppedNow, continuing,
    })
    if (tooFew) {
      stopReason = 'seat-failure'
      stoppedShort = true
      break
    }
    if (!changed) {
      converged = true
      stopReason = singleSeat ? 'single-round' : 'converged'
      break
    }
    if (round === roundLimit) {
      converged = singleSeat
    }
  }

  const merged = mergeFindings(collected, grouping)
  const split = singleSeat
    ? { findings: [...merged.findings, ...merged.dissent], dissent: [] }
    : merged
  const allFindings = [...split.findings, ...split.dissent]
  const terminal = terminalState({
    seatFailures: stoppedShort ? dropouts.map(row => row.error) : [],
    findings: allFindings,
    grouping,
    challengesByKey: lastChallenges,
  })
  const grouped = input.groupIssues === undefined
    ? { status: 'failed' as const, error: 'no grouping call is available', prompts: [] }
    : await groupFindings(allFindings, input.material.manifest, input.outputLanguage, input.groupIssues)
  grouped.prompts.forEach((user, index) => {
    prompts.push({ round: roundLimit + 1 + index, seatId: 'grouping', system: GROUPING_SYSTEM_PROMPT, user })
  })
  const fields: ReportSource = {
    debateId: input.debateId,
    baselineId: input.material.id,
    manifest: input.material.manifest,
    request: input.scope.request,
    guidance: input.scope.guidance,
    guidanceSource: input.scope.guidanceSource,
    grouping,
    terminal,
    converged,
    roundsUsed: rounds.length,
    stopReason,
    dropouts,
    reviewKind,
    uniqueModelCount: modelCount,
    findings: split.findings,
    dissent: split.dissent,
    rounds,
    seats: audit,
    ...grouped.groups !== undefined ? { groups: grouped.groups } : {},
    issueGrouping: {
      status: grouped.status,
      ...grouped.error !== undefined ? { error: grouped.error } : {},
      ...grouped.status !== 'not-needed' && input.groupingRoute !== undefined ? input.groupingRoute : {},
    },
    language: input.outputLanguage ?? '',
  }
  return { ...fields, report: renderReportMarkdown(fields, { audience: 'coordinator' }), prompts }
}
