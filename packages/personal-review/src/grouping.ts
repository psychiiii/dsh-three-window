/**
 * Grouping the review's findings by the issue they are about.
 *
 * Seats describe one issue in their own words, point at one place in
 * different ways, and restate their findings each round, so merging by the
 * location text alone leaves one issue spread over many findings. After the
 * rounds, one context-free call to the review window's own model sorts the
 * findings into groups.
 *
 * The model returns finding numbers only, never text: every wording, seat,
 * and severity the report shows under a group comes from the findings
 * themselves. Its answer is checked mechanically — each number exactly once,
 * no number that does not exist. A number it leaves out is put back as a
 * group of its own ("left over"), so nothing drops out of the report; an
 * invalid answer is retried once with the errors named, and after that the
 * report lists the findings ungrouped and says so.
 *
 * What the check cannot see is a wrong judgement (two issues in one group,
 * or one issue in two). The report makes that visible instead: every wording
 * is listed under its group, disagreeing severities are shown side by side,
 * and a group whose findings name different material items is flagged.
 * @module @psychiiii/dsh-three-window-review/grouping
 */

import { outputLanguageOf } from './output-language.ts'
import { unwrapFence } from './parse.ts'
import type { FindingGroup, MaterialManifestItem, MergedFinding } from './types.ts'

/** Longest group title accepted from the model, in characters. */
const MAX_TITLE_CHARS = 200

/** The fixed instructions of the grouping call. It sees no conversation, no seat, and no model. */
export const GROUPING_SYSTEM_PROMPT = [
  'You sort review findings into groups. Several reviewers examined the same material on their own and over several rounds.',
  'They often describe one issue in different words, point at the same place in different ways, or repeat a finding in a later round.',
  '',
  'Rules:',
  '1. Put findings about the same issue at the same place into one group.',
  '2. Findings about different places, or about different issues at one place, go into different groups.',
  '3. Disagreement does not split a group: if one finding says a place needs changing and another says the same place is fine, both are about that issue and belong together.',
  '4. Do not judge whether a finding is right, and do not drop, merge, or rewrite any wording. You only assign numbers to groups.',
  '5. Every finding number appears in exactly one group. A finding that matches no other is a group of its own.',
  '',
  'Reply with one JSON object and nothing else, no fences:',
  '{"groups": [{"title": "...", "items": [1, 4, 7]}]}',
  'title: a few words naming the issue and where it is.',
].join('\n')

/** One finding as the grouping call sees it: its number, where it points, and what it says. */
export interface GroupingItem {
  readonly n: number
  readonly where: string
  readonly says: readonly string[]
}

/** The findings, numbered 1… in report order (`findings`, then `dissent`). */
export function groupingItems(all: readonly MergedFinding[]): GroupingItem[] {
  return all.map((finding, index) => ({ n: index + 1, where: finding.evidence, says: finding.claims.map(claim => claim.claim) }))
}

/**
 * The grouping call's user text.
 * @param items - numbered findings.
 * @param language - the review window's output language tag, for the titles.
 * @param rejected - errors of a rejected earlier answer, for the one retry.
 */
export function groupingUserPrompt(items: readonly GroupingItem[], language: string | undefined, rejected?: readonly string[]): string {
  const named = outputLanguageOf(language)
  const lines = [
    `Write every title in ${named === undefined ? 'English' : `${named.english} (${named.native})`}.`,
    '',
    `Findings (${String(items.length)}):`,
  ]
  for (const item of items) {
    lines.push(`${String(item.n)}. where: ${item.where.replace(/\s+/gu, ' ').trim()}`)
    for (const text of item.says) lines.push(`   says: ${text.replace(/\s+/gu, ' ').trim()}`)
  }
  if (rejected !== undefined && rejected.length > 0) {
    lines.push('', 'Your previous answer was rejected:', ...rejected.map(error => `- ${error}`), 'Answer again, following the rules.')
  }
  return lines.join('\n')
}

/** A checked answer, or why it was rejected. */
export type CheckedGrouping =
  | { readonly ok: true; readonly groups: { title: string; members: number[] }[]; readonly leftOver: number[] }
  | { readonly ok: false; readonly errors: string[] }

/**
 * Check the model's answer against the finding numbers `1…count`: every
 * number at most once, none outside the range, a title per group. Numbers it
 * never mentions are not an error; they are returned as `leftOver`.
 * @param text - the model's reply.
 * @param count - how many findings there are.
 * @returns groups with 0-based member indices, or the errors.
 */
export function checkGrouping(text: string, count: number): CheckedGrouping {
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrapFence(text))
  } catch {
    return { ok: false, errors: ['the reply is not a JSON object'] }
  }
  const raw = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
    ? (parsed as { groups?: unknown }).groups
    : undefined
  if (!Array.isArray(raw)) return { ok: false, errors: ['the reply has no "groups" array'] }
  const errors: string[] = []
  const seen = new Map<number, number>()
  const groups: { title: string; members: number[] }[] = []
  raw.forEach((entry, index) => {
    const group = entry !== null && typeof entry === 'object' ? entry as { title?: unknown; items?: unknown } : {}
    const title = typeof group.title === 'string' ? group.title.trim() : ''
    if (title.length === 0) errors.push(`group ${String(index + 1)} has no title`)
    if (title.length > MAX_TITLE_CHARS) errors.push(`group ${String(index + 1)} has a title over ${String(MAX_TITLE_CHARS)} characters`)
    if (!Array.isArray(group.items) || group.items.length === 0) {
      errors.push(`group ${String(index + 1)} has no items`)
      return
    }
    const members: number[] = []
    for (const item of group.items) {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > count) {
        errors.push(`group ${String(index + 1)} names ${JSON.stringify(item)}, which is not a finding number (1 to ${String(count)})`)
        continue
      }
      const first = seen.get(item)
      if (first !== undefined) {
        errors.push(`finding ${String(item)} is in group ${String(first + 1)} and again in group ${String(index + 1)}`)
        continue
      }
      seen.set(item, index)
      members.push(item - 1)
    }
    groups.push({ title, members: members.sort((a, b) => a - b) })
  })
  if (errors.length > 0) return { ok: false, errors }
  const leftOver = Array.from({ length: count }, (_, index) => index).filter(index => !seen.has(index + 1))
  return { ok: true, groups: groups.filter(group => group.members.length > 0), leftOver }
}

/** The material items a location names, by label (`M2`) or by path. */
function sourcesNamed(where: string, manifest: readonly MaterialManifestItem[]): Set<string> {
  const out = new Set<string>()
  for (const item of manifest) {
    if (item.status !== 'included') continue
    const base = item.source.split('/').at(-1) ?? item.source
    const byLabel = new RegExp(`(?<![A-Za-z0-9])${item.label}(?![0-9])`, 'u').test(where)
    // A bare file name counts only where it is not the tail of a longer one ("README.md" inside "README.zh-CN.md" is not).
    const byName = new RegExp(`(?<![A-Za-z0-9._-])${base.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![A-Za-z0-9._-])`, 'u').test(where)
    if (byLabel || byName) out.add(item.label)
  }
  return out
}

/**
 * Whether a group's findings point at different material items: two of them
 * each name items and share none. A hint for the reader, not a verdict.
 */
export function namesDifferentSources(members: readonly MergedFinding[], manifest: readonly MaterialManifestItem[]): boolean {
  const named = members.map(member => sourcesNamed(member.evidence, manifest)).filter(set => set.size > 0)
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      if (![...named[i]!].some(label => named[j]!.has(label))) return true
    }
  }
  return false
}

/**
 * The report's groups from a checked answer: the model's groups, then every
 * left-over finding on its own.
 */
export function toFindingGroups(
  checked: Extract<CheckedGrouping, { ok: true }>,
  all: readonly MergedFinding[],
  manifest: readonly MaterialManifestItem[],
): FindingGroup[] {
  const groups: FindingGroup[] = checked.groups.map((group) => {
    const members = group.members.map(index => all[index]!)
    return {
      title: group.title,
      members: group.members,
      ...namesDifferentSources(members, manifest) ? { mixedSources: true as const } : {},
    }
  })
  for (const index of checked.leftOver) groups.push({ title: '', members: [index], leftOver: true })
  return groups
}

/** One tool-less, context-free completion: the grouping system prompt and one user text. */
export type GroupingCompleter = (system: string, user: string) => Promise<
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string }
>

/** What {@link groupFindings} returns: the groups (when grouped), how it went, and the prompts sent. */
export interface GroupingResult {
  readonly groups?: FindingGroup[]
  readonly status: 'grouped' | 'failed' | 'not-needed'
  readonly error?: string
  readonly prompts: readonly string[]
}

/**
 * Sort the findings into groups with at most two calls: the first answer,
 * and one retry naming what was wrong with it.
 * @param all - `[...findings, ...dissent]`.
 * @param manifest - the material list, for the different-sources hint.
 * @param language - output language tag for the titles.
 * @param complete - the call.
 */
export async function groupFindings(
  all: readonly MergedFinding[],
  manifest: readonly MaterialManifestItem[],
  language: string | undefined,
  complete: GroupingCompleter,
): Promise<GroupingResult> {
  if (all.length < 2) return { status: 'not-needed', prompts: [] }
  const items = groupingItems(all)
  const prompts: string[] = []
  let rejected: string[] | undefined
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const user = groupingUserPrompt(items, language, rejected)
    prompts.push(user)
    const reply = await complete(GROUPING_SYSTEM_PROMPT, user)
    if (!reply.ok) return { status: 'failed', error: `the grouping call failed: ${reply.error}`, prompts }
    const checked = checkGrouping(reply.text, all.length)
    if (checked.ok) return { status: 'grouped', groups: toFindingGroups(checked, all, manifest), prompts }
    rejected = checked.errors
  }
  return { status: 'failed', error: `the grouping answer was rejected twice: ${(rejected ?? []).join('; ')}`, prompts }
}
