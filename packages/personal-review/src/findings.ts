/**
 * Finding keys, grouping, and de-identified F-labels.
 *
 * Default grouping is `'evidence'`: keys on normalized evidence only, so two
 * seats that name the same locus with different wording still corroborate.
 * A live A/B run showed 37 `evidence+claim` rows with
 * seatCount 1 collapsing to a handful of evidence loci, most of which were
 * restatements of hardcoded admin/admin, plaintext compare, and missing
 * rate-limit — not 37 distinct defects. The cost is coarser grain: distinct
 * defects on the same evidence line share one finding, take the harshest
 * severity, and keep every claim wording in `claims`.
 * Grouping `'evidence+claim'` keys on normalized evidence plus the trimmed
 * claim, so different wordings stay separate.
 * @module @psychiiii/dsh-three-window-review/findings
 */

import type {
  FindingClaim, GroupingMode, MergedFinding, ReviewFinding, VerdictValue,
} from './types.ts'

/** Severity rank used when merging the same grouping key. */
export const SEVERITY_RANK: Record<VerdictValue, number> = {
  PASS: 0,
  'NEEDS-WORK': 1,
  FAIL: 2,
}

/**
 * Collapse whitespace and case for evidence-key equality.
 * @param evidence - raw evidence string.
 */
export function normalizeEvidence(evidence: string): string {
  return evidence.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Grouping key for one finding. `'evidence'` uses only normalized evidence;
 * `'evidence+claim'` also includes the trimmed claim.
 * @param finding - one finding.
 * @param grouping - merge mode.
 */
export function findingKey(
  finding: Pick<ReviewFinding, 'evidence' | 'claim'>,
  grouping: GroupingMode = 'evidence',
): string {
  const evidence = normalizeEvidence(finding.evidence)
  if (grouping === 'evidence') return evidence
  return `${evidence}\0${finding.claim.trim()}`
}

/**
 * Grouping key for a merged finding (uses the first claim when the mode needs it).
 * @param finding - merged finding.
 * @param grouping - merge mode.
 */
export function mergedFindingKey(finding: MergedFinding, grouping: GroupingMode): string {
  const claim = finding.claims[0]?.claim ?? ''
  return findingKey({ evidence: finding.evidence, claim }, grouping)
}

function maxSeverity(a: VerdictValue, b: VerdictValue): VerdictValue {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b
}

interface Accumulator {
  severity: VerdictValue
  evidence: string
  seats: Set<string>
  claims: Map<string, Set<string>>
}

function sortClaims(claims: readonly FindingClaim[]): FindingClaim[] {
  return [...claims].sort((a, b) => a.claim.localeCompare(b.claim))
}

function sortFindings(items: readonly MergedFinding[]): MergedFinding[] {
  return [...items].sort((a, b) => {
    const evidence = a.evidence.localeCompare(b.evidence)
    if (evidence !== 0) return evidence
    const left = a.claims[0]?.claim ?? ''
    const right = b.claims[0]?.claim ?? ''
    return left.localeCompare(right)
  })
}

function toMerged(item: Accumulator): MergedFinding {
  const seats = [...item.seats].sort((a, b) => a.localeCompare(b))
  const claims: FindingClaim[] = [...item.claims.entries()].map(([claim, claimSeats]) => ({
    claim,
    seats: [...claimSeats].sort((a, b) => a.localeCompare(b)),
  }))
  return {
    severity: item.severity,
    evidence: item.evidence,
    seatCount: seats.length,
    seats,
    claims: sortClaims(claims),
  }
}

/**
 * Merge findings by the selected grouping mode. A key raised by one seat is
 * `dissent`; a key raised by two or more seats is a corroborated finding.
 * Distinct claim wordings under one key are kept as `claims`, never dropped.
 * @param rows - per-seat finding lists.
 * @param grouping - merge mode.
 */
export function mergeFindings(
  rows: readonly { readonly seatId: string; readonly findings: readonly ReviewFinding[] }[],
  grouping: GroupingMode = 'evidence',
): { findings: MergedFinding[]; dissent: MergedFinding[] } {
  const byKey = new Map<string, Accumulator>()
  for (const row of rows) {
    for (const finding of row.findings) {
      const key = findingKey(finding, grouping)
      const claim = finding.claim.trim()
      const current = byKey.get(key)
      if (current === undefined) {
        byKey.set(key, {
          severity: finding.severity,
          evidence: finding.evidence.trim(),
          seats: new Set([row.seatId]),
          claims: new Map([[claim, new Set([row.seatId])]]),
        })
        continue
      }
      current.seats.add(row.seatId)
      current.severity = maxSeverity(current.severity, finding.severity)
      const claimSeats = current.claims.get(claim)
      if (claimSeats === undefined) current.claims.set(claim, new Set([row.seatId]))
      else claimSeats.add(row.seatId)
    }
  }
  const ordered = sortFindings([...byKey.values()].map(toMerged))
  return {
    findings: ordered.filter(item => item.seatCount >= 2),
    dissent: ordered.filter(item => item.seatCount === 1),
  }
}

/** A merged finding labeled `F1`, `F2`, … for a challenge prompt. */
export interface LabeledFinding extends MergedFinding {
  readonly label: string
}

/**
 * Label majority findings and dissent together in stable evidence/claim order.
 * @param findings - majority findings.
 * @param dissent - single-seat findings.
 */
export function labelFindings(
  findings: readonly MergedFinding[],
  dissent: readonly MergedFinding[],
): LabeledFinding[] {
  return sortFindings([...findings, ...dissent]).map((item, index) => ({
    ...item,
    label: `F${String(index + 1)}`,
  }))
}
