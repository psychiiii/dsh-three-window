/**
 * The `personalReview` Session projection: what the review panel shows about
 * the latest `review_debate` run. A pure fold over the Session log:
 *
 * - `personal-review/progress` records (appended by the tool) move a run
 *   through its rounds;
 * - the tool's `tool/result` ends it — with a report (complete, partial, or
 *   failed by {@link runStatusOf}), as cancelled, or, for a running call that
 *   returned no report, as failed;
 * - the coordinator's reply text after a report, until that turn ends, adds
 *   the report's finding ids it mentions to `cited`.
 *
 * Reports written by earlier builds lack newer fields; the report schema
 * fills them with defaults, so a projection rebuild keeps showing them.
 * @module @psychiiii/dsh-three-window-review/panel
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { citedFindingIds, findingIds, runStatusOf } from './report-markdown.ts'
import type { DebateReport, ReviewPanelState, ReviewProgressEvent, ReviewRun } from './types.ts'

const manifestSchema = zod.array(zod.object({
  label: zod.string(),
  source: zod.string(),
  status: zod.union([zod.literal('included'), zod.literal('not-text'), zod.literal('too-large'), zod.literal('over-limit')]),
  bytes: zod.number().optional(),
  lines: zod.number().optional(),
  totalLines: zod.number().optional(),
  why: zod.string().optional(),
  files: zod.array(zod.string()).optional(),
}))

const findingSchema = zod.object({
  severity: zod.union([zod.literal('PASS'), zod.literal('NEEDS-WORK'), zod.literal('FAIL')]),
  scope: zod.union([zod.literal('focus'), zod.literal('other')]).default('focus'),
  evidence: zod.string(),
  seatCount: zod.number(),
  seats: zod.array(zod.string()),
  claims: zod.array(zod.object({
    claim: zod.string(),
    seats: zod.array(zod.string()),
  })),
})

const challengeSchema = zod.object({
  target: zod.string(),
  verdict: zod.union([
    zod.literal('upheld'),
    zod.literal('weakened'),
    zod.literal('contradicted'),
    zod.literal('needs-authority'),
  ]),
  evidence: zod.string(),
})

const causeSchema = zod.union([zod.literal('format'), zod.literal('idle'), zod.literal('overall'), zod.literal('call')])

const dropoutSchema = zod.object({
  seatId: zod.string(),
  round: zod.number(),
  error: zod.string(),
  cause: causeSchema.optional(),
})

/**
 * A report as `tool/result` meta carries it, and as the panel keeps it: the
 * seat prompts are dropped (the log keeps them), and fields added after the
 * first builds default so older reports still parse.
 */
export const panelReportSchema = zod.object({
  debateId: zod.string(),
  baselineId: zod.string(),
  manifest: manifestSchema,
  request: zod.string().default(''),
  guidance: zod.string().default(''),
  guidanceSource: zod.union([zod.literal('workspace'), zod.literal('default'), zod.literal('none')]).default('none'),
  grouping: zod.union([zod.literal('evidence+claim'), zod.literal('evidence')]),
  terminal: zod.union([
    zod.literal('incomplete_review'),
    zod.literal('blocked_by_missing_decision'),
    zod.literal('changes_proposed'),
    zod.literal('clear_within_scope'),
  ]),
  converged: zod.boolean(),
  roundsUsed: zod.number(),
  stopReason: zod.union([zod.literal('single-round'), zod.literal('converged'), zod.literal('round-cap'), zod.literal('seat-failure')]).default('round-cap'),
  dropouts: zod.array(dropoutSchema).default([]),
  reviewKind: zod.union([zod.literal('single-model'), zod.literal('multi-model')]),
  uniqueModelCount: zod.number(),
  findings: zod.array(findingSchema),
  dissent: zod.array(findingSchema),
  rounds: zod.array(zod.object({
    round: zod.number(),
    changed: zod.boolean(),
    seats: zod.array(zod.object({
      seatId: zod.string(),
      ok: zod.boolean(),
      error: zod.string().optional(),
      verdict: zod.union([zod.literal('PASS'), zod.literal('NEEDS-WORK'), zod.literal('FAIL')]).optional(),
      findingCount: zod.number().optional(),
      challenges: zod.array(challengeSchema).optional(),
      finish: zod.string().optional(),
      elapsedMs: zod.number().optional(),
    })),
    elapsedMs: zod.number(),
  })),
  report: zod.string(),
  seats: zod.array(zod.object({
    seatId: zod.string(),
    provider: zod.string(),
    model: zod.string(),
    role: zod.string(),
  })),
  groups: zod.array(zod.object({
    title: zod.string(),
    members: zod.array(zod.number()),
    leftOver: zod.literal(true).optional(),
    mixedSources: zod.literal(true).optional(),
  })).optional(),
  issueGrouping: zod.object({
    status: zod.union([zod.literal('grouped'), zod.literal('failed'), zod.literal('not-needed')]),
    error: zod.string().optional(),
    provider: zod.string().optional(),
    model: zod.string().optional(),
  }).optional(),
  language: zod.string().optional(),
})

const runSchema = zod.object({
  callId: zod.string(),
  status: zod.union([zod.literal('running'), zod.literal('complete'), zod.literal('partial'), zod.literal('failed'), zod.literal('cancelled')]),
  round: zod.number(),
  maxRounds: zod.number(),
  seats: zod.number(),
  remaining: zod.number(),
  roundDone: zod.number().optional(),
  continuing: zod.boolean(),
  dropped: zod.array(dropoutSchema),
})

/** The projection state (and its client view). */
export const panelStateSchema = zod.object({
  run: runSchema.nullable(),
  report: panelReportSchema.nullable(),
  cited: zod.array(zod.string()),
  citing: zod.boolean(),
}) as unknown as ZodType<ReviewPanelState>

/** Before any review ran on the Session. */
export function initialPanel(): ReviewPanelState {
  return { run: null, report: null, cited: [], citing: false }
}

/** The event fields the fold reads; everything else about a Session event is ignored. */
export interface PanelEvent {
  readonly type: string
  readonly data?: unknown
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function toolCallIdOf(data: Record<string, unknown>): string | undefined {
  const id = record(data.message)?.toolCallId
  return typeof id === 'string' ? id : undefined
}

function replyText(data: Record<string, unknown>): string {
  const content = record(data.message)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => record(block))
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block?.text as string)
    .join('\n')
}

function finishedRun(base: ReviewRun | null, callId: string, status: ReviewRun['status'], rounds: number): ReviewRun {
  const same = base !== null && base.callId === callId ? base : null
  return {
    callId,
    status,
    round: same?.round ?? rounds,
    maxRounds: same?.maxRounds ?? rounds,
    seats: same?.seats ?? 0,
    remaining: same?.remaining ?? 0,
    ...same?.roundDone !== undefined ? { roundDone: same.roundDone } : {},
    continuing: false,
    dropped: same?.dropped ?? [],
  }
}

/**
 * Fold one Session event into the panel state.
 * @param state - the state so far.
 * @param event - one Session event.
 * @returns the next state; the same object when the event changes nothing.
 */
export function foldPanel(state: ReviewPanelState, event: PanelEvent): ReviewPanelState {
  const data = record(event.data)
  if (data === undefined) return state
  if (event.type === 'personal-review/progress') {
    const progress = data as unknown as ReviewProgressEvent
    if (progress.phase === 'started') {
      return {
        run: {
          callId: progress.callId,
          status: 'running',
          round: progress.round,
          maxRounds: progress.maxRounds,
          seats: progress.seats,
          remaining: progress.remaining,
          continuing: true,
          dropped: [],
        },
        report: null,
        cited: [],
        citing: false,
      }
    }
    const run = state.run
    if (run === null || run.callId !== progress.callId || run.status !== 'running') return state
    return {
      ...state,
      run: {
        ...run,
        round: progress.continuing ? progress.round + 1 : progress.round,
        roundDone: progress.round,
        remaining: progress.remaining,
        continuing: progress.continuing,
        dropped: [...run.dropped, ...progress.dropped],
      },
    }
  }
  if (event.type === 'tool/result') {
    const callId = toolCallIdOf(data)
    const meta = record(data.meta)
    if (callId === undefined) return state
    if (meta !== undefined && typeof meta.debateId === 'string') {
      const parsed = panelReportSchema.safeParse(meta)
      if (!parsed.success) return state
      // zod's optional fields are `T | undefined`; the report types spell them as absent.
      const report = parsed.data as unknown as Omit<DebateReport, 'prompts'>
      return {
        run: finishedRun(state.run, callId, runStatusOf(report), report.roundsUsed),
        report,
        cited: [],
        citing: true,
      }
    }
    if (meta !== undefined && meta.outcome === 'cancelled' && typeof meta.report === 'string') {
      return { run: finishedRun(null, callId, 'cancelled', 0), report: null, cited: [], citing: false }
    }
    if (state.run?.callId === callId && state.run.status === 'running') {
      return { run: finishedRun(state.run, callId, 'failed', state.run.round), report: null, cited: [], citing: false }
    }
    return state
  }
  if (event.type === 'assistant/message' && state.citing && state.report !== null) {
    const found = citedFindingIds(replyText(data), new Set(findingIds(state.report)))
    const added = found.filter(id => !state.cited.includes(id))
    return added.length === 0 ? state : { ...state, cited: [...state.cited, ...added] }
  }
  if (event.type === 'turn/end') {
    if (state.run?.status === 'running') {
      return { run: finishedRun(state.run, state.run.callId, 'failed', state.run.round), report: null, cited: [], citing: false }
    }
    if (state.citing) return { ...state, citing: false }
  }
  return state
}
