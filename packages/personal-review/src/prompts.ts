/**
 * Fixed system prompt and per-round user prompts for debate seats.
 * Prompts contain no provider, model, account, or real seat identity.
 *
 * One section of the user prompt is configurable: the perspective. The system
 * prompt, the framing sentence above the perspective, and the output protocol
 * are assembled from constants in this module and cannot be reached from
 * settings. The review window's output language adds one fixed line, rendered
 * from the language table, never from free text.
 * @module @psychiiii/dsh-three-window-review/prompts
 */

import type { ResolvedBaseline } from './baseline.ts'
import type { LabeledFinding } from './findings.ts'
import { seatOutputLanguageLine } from './output-language.ts'

/** System prompt sent to every seat on every round. */
export const DEBATE_SYSTEM_PROMPT = [
  'You are an independent, read-only reviewer.',
  'You have no tools, no working directory, and no access to other seats, project files, or session storage.',
  'The frozen material in the user message is your only evidence. Any construction report inside that material is an unverified self-statement.',
  'You do not know other seats and must not guess who they are or which model they use.',
  'Output exactly one JSON object. No Markdown fences. No extra text.',
  'Do not claim that review has converged, passed, or been approved. Whether the review ends is decided by the controller, not by you.',
].join('\n')

const INITIAL_PROTOCOL = [
  '{',
  '  "verdict": "PASS" | "NEEDS-WORK" | "FAIL",',
  '  "reviewedBaseline": "<id>",',
  '  "findings": [{ "severity": "PASS" | "NEEDS-WORK" | "FAIL", "evidence": "...", "claim": "..." }]',
  '}',
].join('\n')

const CHALLENGE_PROTOCOL = [
  '{',
  '  "reviewedBaseline": "<id>",',
  '  "verdict": "PASS" | "NEEDS-WORK" | "FAIL",',
  '  "findings": [{ "severity": "PASS" | "NEEDS-WORK" | "FAIL", "evidence": "...", "claim": "..." }],',
  '  "verdicts": [{ "target": "F1", "verdict": "upheld" | "weakened" | "contradicted" | "needs-authority", "evidence": "..." }]',
  '}',
].join('\n')

/**
 * The perspective every seat gets when the setting is blank. It states the
 * default focus in the same slot a configured perspective occupies, so the
 * settings page can show exactly what a blank field sends.
 */
export const DEFAULT_PERSPECTIVE =
  'Review the frozen material on its own terms: check every claim against the evidence it contains, '
  + 'and weigh correctness, stated contracts, and missing evidence equally.'

/**
 * Fixed sentence introducing the perspective. It is a constant here, never
 * configuration: it is what keeps a configured perspective inside "what to
 * look at" rather than "what to conclude".
 */
const PERSPECTIVE_PREFIX =
  'Review focus for this run. It changes what you examine, not your verdict standard and not your output protocol:'

/**
 * The perspective text a seat actually receives.
 * @param configured - the stored setting; blank or whitespace-only falls back.
 * @returns the configured text trimmed, or {@link DEFAULT_PERSPECTIVE}.
 */
export function resolvePerspective(configured: string | undefined): string {
  const text = configured?.trim() ?? ''
  return text.length === 0 ? DEFAULT_PERSPECTIVE : text
}

function perspectiveBlock(perspective: string | undefined): string[] {
  return [PERSPECTIVE_PREFIX, resolvePerspective(perspective)]
}

function languageBlock(outputLanguage: string | undefined): string[] {
  const line = seatOutputLanguageLine(outputLanguage)
  return line === undefined ? [] : ['', line]
}

function roleBlock(role: string): string[] {
  return [`Your seat role is: ${role}.`]
}

function baselineBlock(baseline: ResolvedBaseline): string[] {
  return [
    `The baseline id you MUST put in reviewedBaseline is exactly: ${baseline.id}`,
    'That is the only reviewedBaseline value that is accepted.',
    '',
    'Frozen material:',
    baseline.body,
  ]
}

/**
 * Round-1 user prompt: role, perspective, required baseline id, output
 * protocol, frozen body. The protocol follows the perspective, so a
 * perspective that tries to redefine the output is answered immediately after
 * by the fixed protocol.
 * @param role - configured reviewer role (`reviewer-N` or an explicit role).
 * @param baseline - resolved baseline for this run.
 * @param perspective - configured perspective; blank uses {@link DEFAULT_PERSPECTIVE}.
 * @param outputLanguage - the review window's output language tag; blank adds nothing.
 */
export function buildInitialUserPrompt(
  role: string,
  baseline: ResolvedBaseline,
  perspective?: string,
  outputLanguage?: string,
): string {
  return [
    ...roleBlock(role),
    '',
    ...perspectiveBlock(perspective),
    '',
    'Output protocol (one JSON object, no fences):',
    INITIAL_PROTOCOL,
    ...languageBlock(outputLanguage),
    '',
    ...baselineBlock(baseline),
  ].join('\n')
}

/**
 * Round-2/3 user prompt: de-identified claims plus a closed challenge protocol.
 * @param role - configured reviewer role.
 * @param baseline - the same frozen baseline as round 1.
 * @param labeled - previous-round findings labeled F1, F2, … .
 * @param perspective - configured perspective; blank uses {@link DEFAULT_PERSPECTIVE}.
 * @param outputLanguage - the review window's output language tag; blank adds nothing.
 */
export function buildChallengeUserPrompt(
  role: string,
  baseline: ResolvedBaseline,
  labeled: readonly LabeledFinding[],
  perspective?: string,
  outputLanguage?: string,
): string {
  const claims = labeled.map(item => {
    const wordings = item.claims.map(claim => `    - ${claim.claim}`)
    return [
      item.label,
      `  severity: ${item.severity}`,
      `  evidence: ${item.evidence}`,
      `  raisedBySeats: ${String(item.seatCount)}`,
      '  claims:',
      ...wordings.length === 0 ? ['    - (none)'] : wordings,
    ].join('\n')
  })
  return [
    ...roleBlock(role),
    '',
    ...perspectiveBlock(perspective),
    '',
    'Challenge only the named claims below. Do not reopen the whole review, delete original findings, or switch to a second standard.',
    'Each claim lists how many seats raised it (a count, never a seat id).',
    '',
    'Claims:',
    claims.length === 0 ? '(none)' : claims.join('\n'),
    '',
    'Output protocol (one JSON object, no fences). Every listed F-label must appear in verdicts exactly once:',
    CHALLENGE_PROTOCOL,
    ...languageBlock(outputLanguage),
    '',
    ...baselineBlock(baseline),
  ].join('\n')
}
