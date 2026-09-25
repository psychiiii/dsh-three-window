/**
 * Debate controller: concurrent seats, mechanical rounds, one in-memory report.
 * @module @psychiiii/dsh-three-window-review/debate
 */

import type { ResolvedBaseline } from './baseline.ts'
import type { SeatCompleteRequest, SeatTextResult } from './complete.ts'
import {
  conclusionsChanged, snapshotConclusions, terminalState, uniqueModelCount,
} from './converge.ts'
import { labelFindings, mergeFindings, mergedFindingKey, type LabeledFinding } from './findings.ts'
import { parseSeatJson, type ParsedChallenge, type ParsedInitial } from './parse.ts'
import { buildChallengeUserPrompt, buildInitialUserPrompt, DEBATE_SYSTEM_PROMPT } from './prompts.ts'
import { renderDebateReport } from './report.ts'
import type {
  ChallengeVerdict, DebatePromptRecord, DebateReport, DebateRound, GroupingMode,
  MergedFinding, ReviewFinding, SeatAudit, SeatRoundResult,
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
  readonly baseline: ResolvedBaseline
  readonly seats: readonly DebateSeat[]
  readonly maxRounds: number
  readonly maxParallel: number
  readonly maxTokens: number
  readonly timeoutMs: number
  readonly grouping: GroupingMode
  /**
   * Configured review perspective, straight from settings. Blank falls back to
   * the built-in default inside the prompt builders, so the seats always
   * receive exactly one perspective section.
   */
  readonly perspective: string
  readonly signal: AbortSignal
  readonly complete: DebateCompleter
}

interface SeatOutcome {
  readonly seatId: string
  readonly ok: boolean
  readonly error?: string
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
  const failures: string[] = []
  let converged = false

  for (let round = 1; round <= roundLimit; round += 1) {
    const mode = round === 1 ? 'initial' : 'challenge'
    const promptLabeled = labeled
    const roundPrompts: DebatePromptRecord[] = new Array(input.seats.length)
    const roundStarted = Date.now()
    const outcomes = await mapPool(input.seats, input.maxParallel, async (seat, index) => {
      const user = mode === 'initial'
        ? buildInitialUserPrompt(seat.role, input.baseline, input.perspective)
        : buildChallengeUserPrompt(seat.role, input.baseline, promptLabeled, input.perspective)
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
        ...seat.reasoningEffort !== undefined ? { reasoningEffort: seat.reasoningEffort } : {},
      }
      const started = Date.now()
      const text = await input.complete(request)
      const elapsedMs = Date.now() - started
      if (!text.ok) {
        return {
          seatId: seat.seatId,
          ok: false,
          error: text.error,
          elapsedMs,
          ...text.finish !== undefined ? { finish: text.finish } : {},
        } satisfies SeatOutcome
      }
      const parsed = parseSeatJson(text.text, {
        mode,
        baselineId: input.baseline.id,
        ...mode === 'challenge' ? { expectedTargets: promptLabeled.map(item => item.label) } : {},
      })
      if (!parsed.ok) {
        return {
          seatId: seat.seatId,
          ok: false,
          error: parsed.error,
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

    for (const row of outcomes) {
      if (!row.ok) failures.push(row.error ?? 'seat failed')
      else if (row.value !== undefined) {
        collected.push({ seatId: row.seatId, findings: row.value.findings })
      }
    }

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

    if (failures.length > 0) break
    if (!changed) {
      converged = true
      break
    }
    if (round === roundLimit) {
      converged = singleSeat && failures.length === 0
    }
  }

  const merged = mergeFindings(collected, grouping)
  const split = singleSeat
    ? { findings: [...merged.findings, ...merged.dissent], dissent: [] }
    : merged
  const allFindings = [...split.findings, ...split.dissent]
  const terminal = terminalState({
    seatFailures: failures,
    findings: allFindings,
    grouping,
    challengesByKey: lastChallenges,
  })
  const report = renderDebateReport({
    debateId: input.debateId,
    baselineId: input.baseline.id,
    grouping,
    terminal,
    converged,
    roundsUsed: rounds.length,
    reviewKind,
    findings: split.findings,
    dissent: split.dissent,
    rounds,
  })
  return {
    debateId: input.debateId,
    baselineId: input.baseline.id,
    grouping,
    terminal,
    converged,
    roundsUsed: rounds.length,
    reviewKind,
    uniqueModelCount: modelCount,
    findings: split.findings,
    dissent: split.dissent,
    rounds,
    report,
    seats: audit,
    prompts,
  }
}
