/**
 * Model-visible debate report text. Never interpolates provider or model names.
 * @module @psychiiii/dsh-three-window-review/report
 */

import type {
  DebateRound, GroupingMode, MergedFinding, ReviewKind, SeatRoundResult, TerminalState,
} from './types.ts'

/** Inputs for {@link renderDebateReport}. */
export interface ReportInput {
  readonly debateId: string
  readonly baselineId: string
  readonly grouping: GroupingMode
  readonly terminal: TerminalState
  readonly converged: boolean
  readonly roundsUsed: number
  readonly reviewKind: ReviewKind
  readonly findings: readonly MergedFinding[]
  readonly dissent: readonly MergedFinding[]
  readonly rounds: readonly DebateRound[]
}

function kindLabel(kind: ReviewKind): string {
  return kind === 'single-model' ? '单模型评审' : '多模型评审'
}

function findingBlock(item: MergedFinding): string {
  const head = `- ${item.severity} ${item.evidence} (seats: ${String(item.seatCount)})`
  const claims = item.claims.map(claim =>
    `  - ${claim.claim} (seats: ${String(claim.seats.length)})`)
  return [head, ...claims].join('\n')
}

function seatLine(item: SeatRoundResult): string {
  if (!item.ok) {
    const finish = item.finish !== undefined ? ` finish=${item.finish}` : ''
    const elapsed = item.elapsedMs !== undefined ? ` elapsedMs=${String(item.elapsedMs)}` : ''
    return `  ${item.seatId} fail ${item.error ?? 'unknown'}${finish}${elapsed}`
  }
  const challenges = item.challenges === undefined || item.challenges.length === 0
    ? ''
    : ` challenges=${item.challenges.map(row => `${row.target}:${row.verdict}`).join(',')}`
  const finish = item.finish !== undefined ? ` finish=${item.finish}` : ''
  const elapsed = item.elapsedMs !== undefined ? ` elapsedMs=${String(item.elapsedMs)}` : ''
  return `  ${item.seatId} ok ${item.verdict ?? ''} findings=${String(item.findingCount ?? 0)}${challenges}${finish}${elapsed}`
}

/**
 * Render the single model-visible report. Seat ids are anonymous. Provider and
 * model names must not appear here. The grouping mode is echoed so two runs
 * can be compared.
 * @param input - controller fields already stripped of route identity.
 */
export function renderDebateReport(input: ReportInput): string {
  const findingLines = input.findings.map(findingBlock)
  const dissentLines = input.dissent.map(findingBlock)
  const roundLines = input.rounds.flatMap(round => [
    `round ${String(round.round)} changed=${String(round.changed)} elapsedMs=${String(round.elapsedMs)}`,
    ...round.seats.map(seatLine),
  ])
  return [
    'anonymous review debate',
    `debate ${input.debateId}`,
    `baseline ${input.baselineId}`,
    `grouping ${input.grouping}`,
    `kind ${kindLabel(input.reviewKind)}`,
    `rounds ${String(input.roundsUsed)}`,
    `stop ${input.reviewKind === 'single-model' && input.roundsUsed === 1 ? '单轮评审' : input.converged ? '提前停止' : '达到轮次上限'}`,
    `terminal ${input.terminal}`,
    'findings:',
    findingLines.length === 0 ? '- (none)' : findingLines.join('\n'),
    'dissent:',
    dissentLines.length === 0 ? '- (none)' : dissentLines.join('\n'),
    'rounds:',
    roundLines.length === 0 ? '- (none)' : roundLines.join('\n'),
  ].join('\n')
}
