/**
 * The review report as Markdown, and the facts the review panel derives from
 * a report: issue numbers, how the run went, and which numbers a reply cites.
 *
 * One pure module serves both readers. The coordinator reads
 * {@link renderReportMarkdown} with `audience: 'coordinator'` as the tool
 * result; the panel's original-report dialog renders the same text with
 * `audience: 'dialog'`, which only appends which provider and model each seat
 * (and the grouping) ran on. The coordinator's copy never names either.
 *
 * Findings are shown by issue: the grouping's groups (`grouping.ts`), each
 * numbered `F1`, `F2`, … with its wordings `F1.1`, `F1.2`, …; a report
 * without groups (grouping failed, or an earlier build) lists each finding as
 * its own numbered item.
 * @module @psychiiii/dsh-three-window-review/report-markdown
 */

import type {
  ChallengeVerdict, DebateReport, DebateRound, DropoutCause, FindingGroup, MergedFinding, RunStatus, SeatDropout,
  SeatRoundResult, StopReason, TerminalState, VerdictValue,
} from './types.ts'

/** The report fields the Markdown is built from. */
export type ReportSource = Omit<DebateReport, 'report' | 'prompts'>

/** Who reads the Markdown: the coordinator (anonymous) or the user's dialog (adds the seat table). */
export type ReportAudience = 'coordinator' | 'dialog'

/**
 * Whether report text is written in Chinese: the review window's output
 * language starts with `zh`. The confirmation dialog uses the same rule.
 * @param language - output language tag, blank or absent for none.
 */
export function isChinese(language: string | undefined): boolean {
  return (language ?? '').startsWith('zh')
}

/** One issue as the report shows it: a group of findings, or one finding when there are no groups. */
export interface ReportIssue {
  /** `F1`, `F2`, … in report order. */
  readonly id: string
  /** The grouping's few words; blank without groups or for a left-over finding. */
  readonly title: string
  /** Its findings; each numbered `F1.1`, … when grouped. */
  readonly members: readonly MergedFinding[]
  /** Distinct seats across its findings, sorted. */
  readonly seats: readonly string[]
  readonly grouped: boolean
  readonly leftOver: boolean
  readonly mixedSources: boolean
  /** In scope when any of its findings is. */
  readonly scope: 'focus' | 'other'
}

/**
 * The report's issues, in report order: those two or more seats raised first,
 * then those one seat raised.
 * @param report - findings, dissent, and the groups when there are any.
 */
export function reportIssues(report: Pick<ReportSource, 'findings' | 'dissent' | 'groups'>): ReportIssue[] {
  const all = [...report.findings, ...report.dissent]
  const raw: { title: string; members: MergedFinding[]; group?: FindingGroup }[] = report.groups === undefined
    ? all.map(finding => ({ title: '', members: [finding] }))
    : report.groups.map(group => ({
      title: group.title,
      members: group.members.map(index => all[index]).filter((item): item is MergedFinding => item !== undefined),
      group,
    }))
  const shaped = raw.filter(item => item.members.length > 0).map((item) => {
    const seats = [...new Set(item.members.flatMap(member => member.seats))].sort()
    return {
      title: item.title,
      members: item.members,
      seats,
      grouped: report.groups !== undefined,
      leftOver: item.group?.leftOver === true,
      mixedSources: item.group?.mixedSources === true,
      scope: item.members.some(member => member.scope === 'focus') ? 'focus' as const : 'other' as const,
    }
  })
  const ordered = [...shaped.filter(item => item.seats.length >= 2), ...shaped.filter(item => item.seats.length < 2)]
  return ordered.map((item, index) => ({ ...item, id: `F${String(index + 1)}` }))
}

/**
 * The number of every issue, in report order.
 * @param report - findings, dissent, and the groups when there are any.
 */
export function findingIds(report: Pick<ReportSource, 'findings' | 'dissent' | 'groups'>): string[] {
  return reportIssues(report).map(issue => issue.id)
}

/**
 * The finding ids a text mentions, each once, in first-mention order; only
 * ids in `known` count.
 * @param text - reply text.
 * @param known - the report's ids.
 */
export function citedFindingIds(text: string, known: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/(?<![A-Za-z0-9])F(\d{1,5})(?![0-9])/gu)) {
    const id = `F${String(Number(match[1]))}`
    if (known.has(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * How a finished run went. A run that stopped for lack of seats, or whose
 * conclusion is "incomplete", did not complete; one where some seats dropped
 * out but the rest reached a conclusion completed partly.
 * @param report - stop reason, terminal, and dropouts.
 */
export function runStatusOf(report: Pick<ReportSource, 'stopReason' | 'terminal' | 'dropouts'>): Exclude<RunStatus, 'running' | 'cancelled'> {
  if (report.stopReason === 'seat-failure' || report.terminal === 'incomplete_review') return 'failed'
  return report.dropouts.length > 0 ? 'partial' : 'complete'
}

/**
 * A dropout's cause: the recorded one, else read from its error text (reports
 * written before causes were recorded).
 * @param dropout - one dropout.
 */
export function dropoutCause(dropout: Pick<SeatDropout, 'error' | 'cause'>): DropoutCause {
  if (dropout.cause !== undefined) return dropout.cause
  const error = dropout.error
  if (error.startsWith('seat produced no output')) return 'idle'
  if (error.startsWith('seat reached the overall limit')) return 'overall'
  const callErrors = ['seat call aborted', 'seat emitted', 'seat ended with', 'seat stream failed', 'seat must emit']
  return callErrors.some(prefix => error.startsWith(prefix)) ? 'call' : 'format'
}

interface Words {
  readonly conclusion: Record<TerminalState, string>
  readonly verdict: Record<VerdictValue, string>
  readonly stop: Record<StopReason, string>
  readonly cause: Record<DropoutCause, string>
  readonly challenge: Record<ChallengeVerdict, string>
  readonly labels: {
    readonly conclusion: string
    readonly request: string
    readonly requestNone: string
    readonly guidance: string
    readonly guidanceNone: string
    readonly guidanceSource: { readonly workspace: string; readonly default: string }
    readonly run: string
    readonly dropped: string
    readonly material: string
    readonly none: string
    readonly outside: string
    readonly where: string
    readonly says: string
    readonly judged: string
    readonly leftOver: string
    readonly mixed: string
    readonly rounds: string
    readonly seats: string
    readonly seatCol: string
    readonly roleCol: string
    readonly routeCol: string
  }
  readonly grouped: {
    readonly multi: string
    readonly single: string
    readonly note: string
  }
  readonly ungrouped: {
    readonly multi: string
    readonly single: string
    readonly note: (error: string | undefined) => string
  }
  groupedBy(provider: string, model: string): string
  run(kind: DebateReport['reviewKind'], seats: number, rounds: number, stop: string): string
  raisedBy(seats: readonly string[]): string
  issues(n: number, grouped: boolean): string
  lines(item: { lines?: number; totalLines?: number }): string
  skipped(reason: string): string
  touches(files: string, more: number): string
  dropout(row: SeatDropout, cause: string): string
  roundTitle(n: number): string
  duration(ms: number): string
  seatLine(seat: SeatRoundResult, cause: string): string
  paren(text: string): string
  colon: string
  list: string
}

const ZH: Words = {
  conclusion: {
    clear_within_scope: '这次评审范围内没发现需要改的问题。',
    changes_proposed: '建议修改后再使用。',
    blocked_by_missing_decision: '有只能由你决定的问题，评审无法替你决定。',
    incomplete_review: '评审没有完成，原因见下面的运行情况。',
  },
  verdict: { PASS: '无需修改', 'NEEDS-WORK': '建议修改', FAIL: '必须修改' },
  stop: {
    'single-round': '单轮评审',
    converged: '意见不再变化，提前结束',
    'round-cap': '达到轮次上限（每一轮意见都还在变）',
    'seat-failure': '评审席失败，剩余不足，已中止',
  },
  cause: { format: '输出格式不对', idle: '长时间没有输出', overall: '超过总时长上限', call: '调用出错' },
  challenge: { upheld: '同意', weakened: '认为证据不足', contradicted: '认为不成立', 'needs-authority': '认为要由你决定' },
  labels: {
    conclusion: '结论',
    request: '这次要看',
    requestNone: '未指定，整体评审',
    guidance: '评审口径',
    guidanceNone: '未设置，只按内置的通用标准',
    guidanceSource: { workspace: '本工作区', default: '默认' },
    run: '运行',
    dropped: '中途退出',
    material: '评审的材料',
    none: '无',
    outside: '不在这次要看的范围内',
    where: '位置',
    says: '说法',
    judged: '判断',
    leftOver: '归类时没有归入任何一组，单独列出',
    mixed: '留意：这一组的原话指向不同的材料，可能归错了组',
    rounds: '各轮情况',
    seats: '评审席',
    seatCol: '席位',
    roleCol: '角色',
    routeCol: '提供方 / 模型',
  },
  grouped: {
    multi: '多位评审者都提到的',
    single: '只有一位评审者提到的',
    note: '同一件事已归成一组：归类只分组，不改写，每组下面列出全部原话。F 编号是一件事，F3.1 这样的小编号是其中一句原话。',
  },
  ungrouped: {
    multi: '多位评审者提出的意见',
    single: '只有一位评审者提出的意见',
    note: error => `这次没能把同一件事归成一组${error === undefined ? '' : `（${error}）`}，下面逐条列出，同一件事可能出现多次。`,
  },
  groupedBy: (provider, model) => `归类用的模型：${provider} / ${model}（审核窗的主模型，不带对话上下文）`,
  run: (kind, seats, rounds, stop) => `${kind === 'single-model' ? '单模型评审' : '多模型评审'}，${String(seats)} 个评审席，共 ${String(rounds)} 轮，${stop}`,
  raisedBy: seats => `${String(seats.length)} 位评审者：${seats.join('、')}`,
  issues: (n, grouped) => `${String(n)} ${grouped ? '件' : '条'}`,
  lines: item => item.totalLines !== undefined
    ? `只取前 ${String(item.lines ?? 0)} 行，共 ${String(item.totalLines)} 行`
    : `${String(item.lines ?? 0)} 行`,
  skipped: reason => `未纳入：${reason}`,
  touches: (files, more) => `涉及：${files}${more > 0 ? ` 等共 ${String(more)} 个文件` : ''}`,
  dropout: (row, cause) => `${row.seatId}（第 ${String(row.round)} 轮，${cause}）`,
  roundTitle: n => (n === 1 ? '第 1 轮：各自独立评审' : `第 ${String(n)} 轮：看过上一轮的全部意见后逐条表态`),
  duration: (ms) => {
    const s = Math.round(ms / 1000)
    return s < 60 ? `${String(s)} 秒` : `${String(Math.floor(s / 60))} 分 ${String(s % 60)} 秒`
  },
  seatLine: (seat, cause) => {
    if (!seat.ok) return `这一轮没有交回（${cause}）`
    const verdict = seat.verdict === undefined ? '' : `整体判断${ZH.verdict[seat.verdict]}；`
    const stance = stanceText(seat, ZH.challenge, '、', ' ')
    return `${verdict}这一轮提出 ${String(seat.findingCount ?? 0)} 条${stance === undefined ? '' : `；对上一轮的 ${String(seat.challenges?.length ?? 0)} 条意见：${stance}`}`
  },
  paren: text => `（${text}）`,
  colon: '：',
  list: '、',
}

const EN: Words = {
  conclusion: {
    clear_within_scope: 'No problem that needs changing was found within this review.',
    changes_proposed: 'Changes are recommended before this is used.',
    blocked_by_missing_decision: 'There is a question only the user can decide; the review cannot settle it.',
    incomplete_review: 'The review did not complete; see the run below for why.',
  },
  verdict: { PASS: 'no change needed', 'NEEDS-WORK': 'should change', FAIL: 'must change' },
  stop: {
    'single-round': 'a single round',
    converged: 'the findings stopped changing, ended early',
    'round-cap': 'reached the round limit (the findings still changed every round)',
    'seat-failure': 'too few seats left after failures, stopped',
  },
  cause: { format: 'answer not in the required format', idle: 'no output for too long', overall: 'ran past the overall time limit', call: 'the call failed' },
  challenge: { upheld: 'agreed', weakened: 'found the evidence thin', contradicted: 'found it wrong', 'needs-authority': 'left it to you' },
  labels: {
    conclusion: 'Conclusion',
    request: 'This time',
    requestNone: 'no focus named; the material as a whole',
    guidance: 'Standing guidance',
    guidanceNone: 'none; built-in general criteria only',
    guidanceSource: { workspace: 'this workspace', default: 'default' },
    run: 'Run',
    dropped: 'Dropped out',
    material: 'Material reviewed',
    none: 'none',
    outside: 'outside what this review was asked to look at',
    where: 'Where',
    says: 'Says',
    judged: 'Judged',
    leftOver: 'the grouping put this in no group, so it stands alone',
    mixed: 'note: the wordings in this group point at different material; the grouping may be wrong',
    rounds: 'Rounds',
    seats: 'Seats',
    seatCol: 'Seat',
    roleCol: 'Role',
    routeCol: 'Provider / model',
  },
  grouped: {
    multi: 'Raised by two or more reviewers',
    single: 'Raised by one reviewer',
    note: 'Findings about one issue are grouped: the grouping only sorts, never rewrites, and every wording is listed under its group. An F number is one issue; a number such as F3.1 is one wording in it.',
  },
  ungrouped: {
    multi: 'Findings raised by two or more reviewers',
    single: 'Findings raised by one reviewer',
    note: error => `The findings could not be grouped by issue${error === undefined ? '' : ` (${error})`}; they are listed one by one, and one issue may appear more than once.`,
  },
  groupedBy: (provider, model) => `Grouped by: ${provider} / ${model} (the review window's own model, with no conversation context)`,
  run: (kind, seats, rounds, stop) => `${kind === 'single-model' ? 'single-model review' : 'multi-model review'}, ${String(seats)} seat(s), ${String(rounds)} round(s), ${stop}`,
  raisedBy: seats => `${String(seats.length)} reviewer${seats.length === 1 ? '' : 's'}: ${seats.join(', ')}`,
  issues: (n, grouped) => `${String(n)} ${grouped ? (n === 1 ? 'issue' : 'issues') : (n === 1 ? 'finding' : 'findings')}`,
  lines: item => item.totalLines !== undefined
    ? `first ${String(item.lines ?? 0)} of ${String(item.totalLines)} lines`
    : `${String(item.lines ?? 0)} lines`,
  skipped: reason => `not included: ${reason}`,
  touches: (files, more) => `touches: ${files}${more > 0 ? `, ${String(more)} files in all` : ''}`,
  dropout: (row, cause) => `${row.seatId} (round ${String(row.round)}, ${cause})`,
  roundTitle: n => (n === 1 ? 'Round 1: each reviewer on its own' : `Round ${String(n)}: each reviewer answers every finding of the round before`),
  duration: (ms) => {
    const s = Math.round(ms / 1000)
    return s < 60 ? `${String(s)} s` : `${String(Math.floor(s / 60))} min ${String(s % 60)} s`
  },
  seatLine: (seat, cause) => {
    if (!seat.ok) return `did not answer this round (${cause})`
    const verdict = seat.verdict === undefined ? '' : `overall ${EN.verdict[seat.verdict]}; `
    const stance = stanceText(seat, EN.challenge, ', ', ' ')
    return `${verdict}raised ${String(seat.findingCount ?? 0)} this round${stance === undefined ? '' : `; on the ${String(seat.challenges?.length ?? 0)} findings of the round before: ${stance}`}`
  },
  paren: text => ` (${text})`,
  colon: ': ',
  list: ', ',
}

/** A seat's answers to the round before, counted, non-zero counts only, e.g. "同意 16、认为证据不足 10". */
function stanceText(seat: SeatRoundResult, names: Record<ChallengeVerdict, string>, sep: string, gap: string): string | undefined {
  if (seat.challenges === undefined || seat.challenges.length === 0) return undefined
  const tally: Record<ChallengeVerdict, number> = { upheld: 0, weakened: 0, contradicted: 0, 'needs-authority': 0 }
  for (const row of seat.challenges) tally[row.verdict] += 1
  return (Object.keys(tally) as ChallengeVerdict[])
    .filter(verdict => tally[verdict] > 0)
    .map(verdict => `${names[verdict]}${gap}${String(tally[verdict])}`)
    .join(sep)
}

/** Most changed files listed under one version-control item. */
const FILES_SHOWN = 20

function escapeMarkup(text: string): string {
  return text.replace(/[\\`*_[\]<>|~$#]/gu, char => `\\${char}`)
}

/**
 * Inline text from a model or a user as literal Markdown: whitespace runs
 * collapse to one space, and the characters that would start markup (or TeX,
 * which the dialog renders) are escaped — except a balanced backtick span,
 * which stays inline code as its writer meant: inside one, nothing else is
 * markup anyway, and an unbalanced backtick is escaped like the rest.
 */
function literal(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const out: string[] = []
  let rest = flat
  for (;;) {
    const match = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/u.exec(rest)
    if (match === null) break
    out.push(escapeMarkup(rest.slice(0, match.index)), match[0])
    rest = rest.slice(match.index + match[0].length)
  }
  out.push(escapeMarkup(rest))
  return out.join('')
    .replace(/^(\d+)([.)])/u, '$1\\$2')
    .replace(/^([-+])/u, '\\$1')
}

/** A path or name as inline code, choosing a fence the text does not contain. */
function code(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const longest = Math.max(0, ...Array.from(flat.matchAll(/`+/gu), match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${flat}${pad}${fence}`
}

/** Who judged what across an issue's findings: `建议修改：seat-1、seat-2；无需修改：seat-3`. */
function judgement(members: readonly MergedFinding[], words: Words): string {
  const bySeverity = new Map<VerdictValue, Set<string>>()
  for (const severity of ['FAIL', 'NEEDS-WORK', 'PASS'] as const) {
    const seats = new Set(members.filter(member => member.severity === severity).flatMap(member => member.seats))
    if (seats.size > 0) bySeverity.set(severity, seats)
  }
  return [...bySeverity.entries()]
    .map(([severity, seats]) => `${words.verdict[severity]}${words.colon}${[...seats].sort().join(words.list)}`)
    .join(words === ZH ? '；' : '; ')
}

/** One finding's lines at `indent`: head (number, seats, severity), where it points, what it says. */
function findingLines(finding: MergedFinding, id: string, indent: string, words: Words, outside: boolean): string[] {
  const l = words.labels
  const quote = words === ZH ? (text: string) => `「${text}」` : (text: string) => `“${text}”`
  const head = [`**${id}**`, finding.seats.join(words.list), words.verdict[finding.severity], ...outside ? [l.outside] : []].join(' · ')
  const lines = [`${indent}- ${head}\\`, `${indent}  ${l.where}${words.colon}${quote(literal(finding.evidence))}`]
  if (finding.claims.length === 1) {
    lines[lines.length - 1] += '\\'
    lines.push(`${indent}  ${l.says}${words.colon}${literal(finding.claims[0]!.claim)}`)
  } else {
    for (const claim of finding.claims) lines.push(`${indent}  - ${literal(claim.claim)}${words.paren(claim.seats.join(words.list))}`)
  }
  return lines
}

function issueLines(issue: ReportIssue, words: Words): string[] {
  const l = words.labels
  if (!issue.grouped) return findingLines(issue.members[0]!, issue.id, '', words, issue.scope === 'other')
  const head = [`**${issue.id}**`, words.raisedBy(issue.seats), ...issue.scope === 'other' ? [l.outside] : []].join(' · ')
  const lines = [`- ${head}${issue.title.length > 0 ? '\\' : ''}`]
  if (issue.title.length > 0) lines.push(`  ${literal(issue.title)}`)
  if (issue.leftOver) lines.push(`  - ${l.leftOver}`)
  lines.push(`  - ${l.judged}${words.colon}${judgement(issue.members, words)}`)
  if (issue.mixedSources) lines.push(`  - ${l.mixed}`)
  issue.members.forEach((member, index) => {
    lines.push(...findingLines(member, `${issue.id}.${String(index + 1)}`, '  ', words, false))
  })
  return lines
}

/**
 * One item per round, one line per seat under it. A table would need a column
 * per seat, and dsh keeps a wide table at its natural width with the overflow
 * hidden until hovered.
 */
function roundList(rounds: readonly DebateRound[], seatIds: readonly string[], dropouts: readonly SeatDropout[], words: Words): string[] {
  const causeOf = (seatId: string, round: number): string => {
    const row = dropouts.find(item => item.seatId === seatId && item.round === round)
    return words.cause[row === undefined ? 'call' : dropoutCause(row)]
  }
  return rounds.flatMap(round => [
    `- **${words.roundTitle(round.round)}** · ${words.duration(round.elapsedMs)}`,
    ...seatIds.flatMap((seatId) => {
      const seat = round.seats.find(item => item.seatId === seatId)
      return seat === undefined ? [] : [`  - ${literal(seatId)}${words.colon}${literal(words.seatLine(seat, causeOf(seatId, round.round)))}`]
    }),
  ])
}

/**
 * The report as Markdown, in the report's language (Chinese for a `zh…`
 * output language, English otherwise).
 * @param report - the controller's fields.
 * @param options - who reads it, and the language when the report carries none.
 * @returns Markdown text.
 */
export function renderReportMarkdown(
  report: ReportSource,
  options: { readonly audience: ReportAudience; readonly language?: string },
): string {
  const words = isChinese(report.language ?? options.language) ? ZH : EN
  const l = words.labels
  // The colon stays outside the bold: a closing `**` right after punctuation
  // and before a letter is not a closing delimiter, so 「**中途退出：**seat-3」
  // would show its asterisks.
  const label = (text: string): string => (words === ZH ? `**${text}**：` : `**${text}:** `)
  const out: string[] = []
  out.push(`${label(l.conclusion)}${words.conclusion[report.terminal]}`)
  out.push('')
  const request = report.request.trim()
  const guidance = report.guidance.trim()
  out.push(`- ${label(l.request)}${request.length === 0 ? l.requestNone : literal(request)}`)
  out.push(`- ${label(l.guidance)}${report.guidanceSource === 'none' || guidance.length === 0
    ? l.guidanceNone
    : `${literal(guidance)}${words.paren(l.guidanceSource[report.guidanceSource])}`}`)
  out.push(`- ${label(l.run)}${words.run(report.reviewKind, report.seats.length, report.roundsUsed, words.stop[report.stopReason])}`)
  if (report.dropouts.length > 0) {
    out.push(`- ${label(l.dropped)}${report.dropouts.map(row => literal(words.dropout(row, words.cause[dropoutCause(row)]))).join(words === ZH ? '；' : '; ')}`)
  }
  out.push('')
  out.push(`### ${l.material}`)
  out.push('')
  for (const item of report.manifest) {
    if (item.status !== 'included') {
      const reason = words === ZH
        ? { 'not-text': '不是文本文件', 'too-large': '文件太大', 'over-limit': '超出这次评审的大小或数量上限' }[item.status]
        : { 'not-text': 'not a text file', 'too-large': 'too large', 'over-limit': 'over this review’s size or file limit' }[item.status]
      out.push(`- ~~${code(item.source)}~~ ${words.skipped(reason)}`)
      continue
    }
    out.push(`- ${code(item.source)} · ${words.lines(item)}`)
    if (item.files !== undefined && item.files.length > 0) {
      const shown = item.files.slice(0, FILES_SHOWN).map(code).join(words.list)
      out.push(`  - ${words.touches(shown, item.files.length > FILES_SHOWN ? item.files.length : 0)}`)
    }
  }
  const issues = reportIssues(report)
  const grouped = report.groups !== undefined
  const titles = grouped ? words.grouped : words.ungrouped
  out.push('')
  out.push(grouped ? words.grouped.note : words.ungrouped.note(report.issueGrouping?.status === 'failed' ? report.issueGrouping.error : undefined))
  const section = (title: string, items: readonly ReportIssue[]): void => {
    out.push('')
    out.push(`### ${title}${words.paren(words.issues(items.length, grouped))}`)
    out.push('')
    if (items.length === 0) out.push(`- ${l.none}`)
    for (const issue of items) out.push(...issueLines(issue, words))
  }
  section(titles.multi, issues.filter(issue => issue.seats.length >= 2))
  section(titles.single, issues.filter(issue => issue.seats.length < 2))
  out.push('')
  out.push(`### ${l.rounds}`)
  out.push('')
  const seatIds = report.seats.map(seat => seat.seatId)
  out.push(...roundList(report.rounds, seatIds, report.dropouts, words))
  if (options.audience === 'dialog') {
    out.push('')
    out.push(`### ${l.seats}`)
    out.push('')
    out.push(`| ${literal(l.seatCol)} | ${literal(l.roleCol)} | ${literal(l.routeCol)} |`)
    out.push('| --- | --- | --- |')
    for (const seat of report.seats) {
      out.push(`| ${literal(seat.seatId)} | ${literal(seat.role)} | ${literal(`${seat.provider} / ${seat.model}`)} |`)
    }
    const by = report.issueGrouping
    if (by?.provider !== undefined && by.model !== undefined) {
      out.push('')
      out.push(literal(words.groupedBy(by.provider, by.model)))
    }
  }
  return out.join('\n')
}
