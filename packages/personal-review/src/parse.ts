/**
 * Strict seat JSON parse. The only tolerance is a whole-text Markdown fence.
 * @module @psychiiii/dsh-three-window-review/parse
 */

import {
  CHALLENGE_VERDICTS, MAX_SEAT_STRING_CHARS, VERDICT_VALUES,
  type ChallengeRow, type ChallengeVerdict, type ReviewFinding, type VerdictValue,
} from './types.ts'

const FENCE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/

/** Parsed round-1 object. Extra JSON keys are ignored. */
export interface ParsedInitial {
  readonly kind: 'initial'
  readonly verdict: VerdictValue
  readonly reviewedBaseline: string
  readonly findings: readonly ReviewFinding[]
}

/** Parsed round-2/3 object. Extra JSON keys are ignored. */
export interface ParsedChallenge {
  readonly kind: 'challenge'
  readonly verdict: VerdictValue
  readonly reviewedBaseline: string
  readonly findings: readonly ReviewFinding[]
  readonly verdicts: readonly ChallengeRow[]
}

/** Result of parsing one seat body. */
export type ParsedSeat =
  | { readonly ok: true; readonly value: ParsedInitial | ParsedChallenge }
  | { readonly ok: false; readonly error: string }

function fail(error: string): ParsedSeat {
  return { ok: false, error }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Strip a wrapping Markdown fence when it covers the whole body.
 * @param text - raw seat text.
 */
export function unwrapFence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(FENCE)
  const inner = match?.[1]
  return inner !== undefined ? inner.trim() : trimmed
}

function asVerdict(value: unknown): VerdictValue | undefined {
  if (typeof value !== 'string') return undefined
  return (VERDICT_VALUES as readonly string[]).includes(value) ? value as VerdictValue : undefined
}

function asChallenge(value: unknown): ChallengeVerdict | undefined {
  if (typeof value !== 'string') return undefined
  return (CHALLENGE_VERDICTS as readonly string[]).includes(value) ? value as ChallengeVerdict : undefined
}

function parseString(value: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') return { ok: false, error: `missing or invalid ${label}` }
  if (value.length > MAX_SEAT_STRING_CHARS) {
    return { ok: false, error: `${label} exceeds ${String(MAX_SEAT_STRING_CHARS)} characters` }
  }
  return { ok: true, value }
}

function parseFindings(value: unknown): { ok: true; value: ReviewFinding[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'missing or invalid findings' }
  const findings: ReviewFinding[] = []
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return { ok: false, error: `invalid findings[${String(index)}]` }
    const severity = asVerdict(item.severity)
    if (severity === undefined) {
      return { ok: false, error: `findings[${String(index)}].severity is not in the closed set` }
    }
    const evidence = parseString(item.evidence, `findings[${String(index)}].evidence`)
    if (!evidence.ok) return evidence
    const claim = parseString(item.claim, `findings[${String(index)}].claim`)
    if (!claim.ok) return claim
    findings.push({ severity, evidence: evidence.value, claim: claim.value })
  }
  return { ok: true, value: findings }
}

function parseChallenges(
  value: unknown,
  expectedTargets: readonly string[],
): { ok: true; value: ChallengeRow[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'missing or invalid verdicts' }
  const expected = new Set(expectedTargets)
  const seen = new Set<string>()
  const rows: ChallengeRow[] = []
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return { ok: false, error: `invalid verdicts[${String(index)}]` }
    const target = parseString(item.target, `verdicts[${String(index)}].target`)
    if (!target.ok) return target
    if (!expected.has(target.value)) {
      return { ok: false, error: `verdicts[${String(index)}].target ${JSON.stringify(target.value)} is not a listed claim` }
    }
    if (seen.has(target.value)) {
      return { ok: false, error: `verdicts target ${JSON.stringify(target.value)} is duplicated` }
    }
    seen.add(target.value)
    const verdict = asChallenge(item.verdict)
    if (verdict === undefined) {
      return { ok: false, error: `verdicts[${String(index)}].verdict is not in the closed set` }
    }
    const evidence = parseString(item.evidence, `verdicts[${String(index)}].evidence`)
    if (!evidence.ok) return evidence
    rows.push({ target: target.value, verdict, evidence: evidence.value })
  }
  const missing = expectedTargets.filter(label => !seen.has(label))
  if (missing.length > 0) {
    return { ok: false, error: `verdicts missing target ${missing.join(', ')}` }
  }
  return { ok: true, value: rows }
}

/** Parse options that differ by round. */
export interface ParseSeatOptions {
  /** Round 1 has no `verdicts`; later rounds must cover every labeled claim. */
  readonly mode: 'initial' | 'challenge'
  /** Baseline id the seat must echo. */
  readonly baselineId: string
  /** F-labels that `verdicts` must cover exactly when `mode` is `challenge`. */
  readonly expectedTargets?: readonly string[]
}

/**
 * Parse one seat body. Extra keys such as a self-declared converged flag are
 * ignored and never change controller state.
 * @param text - raw assembled text.
 * @param options - round mode and required baseline / targets.
 */
export function parseSeatJson(text: string, options: ParseSeatOptions): ParsedSeat {
  const body = unwrapFence(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return fail('seat output is not JSON')
  }
  if (!isRecord(parsed)) return fail('seat output is not a JSON object')
  const verdict = asVerdict(parsed.verdict)
  if (verdict === undefined) return fail('verdict is not in the closed set')
  const reviewed = parseString(parsed.reviewedBaseline, 'reviewedBaseline')
  if (!reviewed.ok) return reviewed
  if (reviewed.value !== options.baselineId) {
    return fail('reviewedBaseline does not match')
  }
  const findings = parseFindings(parsed.findings)
  if (!findings.ok) return findings
  if (options.mode === 'initial') {
    return {
      ok: true,
      value: {
        kind: 'initial',
        verdict,
        reviewedBaseline: reviewed.value,
        findings: findings.value,
      },
    }
  }
  const expected = options.expectedTargets ?? []
  const verdicts = parseChallenges(parsed.verdicts, expected)
  if (!verdicts.ok) return verdicts
  return {
    ok: true,
    value: {
      kind: 'challenge',
      verdict,
      reviewedBaseline: reviewed.value,
      findings: findings.value,
      verdicts: verdicts.value,
    },
  }
}
