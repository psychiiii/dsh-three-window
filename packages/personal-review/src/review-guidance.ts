/**
 * Standing review guidance per Workspace: what reviews in that Workspace
 * should weigh (layer 2 of the review prompt), set by the user and kept until
 * changed. A Workspace without its own guidance uses the default one — the
 * setting once called the review perspective — so profiles that already hold
 * a perspective keep it without any migration.
 *
 * Entries are keyed by the Workspace's root path, stored and matched exactly
 * like the per-Workspace turn prompt. Pure: the browser half imports it too.
 * @module @psychiiii/dsh-three-window-review/review-guidance
 */

import { normalizeWorkspaceRoot } from './workspace-prompt.ts'

/** Longest guidance one Workspace may hold, in UTF-16 code units. */
export const REVIEW_GUIDANCE_MAX = 4000

/** Most Workspaces that may hold guidance at once. */
export const REVIEW_GUIDANCE_ENTRIES_MAX = 200

/** One Workspace's guidance as stored. */
export interface ReviewGuidanceEntry {
  /** The Workspace's root path, normalized. */
  readonly root: string
  /** The text, verbatim. */
  readonly text: string
}

/**
 * Read the stored entries out of a section, tolerating anything: an entry
 * that is not a root plus non-blank text within the limit is dropped, and a
 * later entry for the same root replaces an earlier one.
 * @param section - the `personal-settings` Config section, or any object.
 * @returns the usable entries, in stored order.
 */
export function reviewGuidanceFromSection(section: unknown): ReviewGuidanceEntry[] {
  const raw = section !== null && typeof section === 'object' && !Array.isArray(section)
    ? (section as { reviewGuidance?: unknown }).reviewGuidance
    : undefined
  if (!Array.isArray(raw)) return []
  const byRoot = new Map<string, ReviewGuidanceEntry>()
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const { root, text } = item as { root?: unknown; text?: unknown }
    if (typeof root !== 'string' || root.length === 0 || typeof text !== 'string') continue
    if (text.trim().length === 0 || text.length > REVIEW_GUIDANCE_MAX) continue
    const key = normalizeWorkspaceRoot(root)
    byRoot.delete(key)
    byRoot.set(key, { root: key, text })
  }
  return [...byRoot.values()]
}

/**
 * The entries after setting one Workspace's guidance; blank text removes it,
 * so that Workspace falls back to the default.
 * @param entries - current entries.
 * @param root - the Workspace's root path.
 * @param text - the new text.
 * @returns the next entries.
 * @throws when the text is over {@link REVIEW_GUIDANCE_MAX} or the table would exceed
 *   {@link REVIEW_GUIDANCE_ENTRIES_MAX} entries.
 */
export function withReviewGuidance(
  entries: readonly ReviewGuidanceEntry[],
  root: string,
  text: string,
): ReviewGuidanceEntry[] {
  if (text.length > REVIEW_GUIDANCE_MAX) {
    throw new Error(`the review guidance is ${String(text.length)} characters; the limit is ${String(REVIEW_GUIDANCE_MAX)}`)
  }
  const key = normalizeWorkspaceRoot(root)
  const rest = entries.filter(entry => normalizeWorkspaceRoot(entry.root) !== key)
  if (text.trim().length === 0) return rest
  if (rest.length >= REVIEW_GUIDANCE_ENTRIES_MAX) {
    throw new Error(`at most ${String(REVIEW_GUIDANCE_ENTRIES_MAX)} workspaces can hold review guidance`)
  }
  return [...rest, { root: key, text }]
}

/**
 * The entry whose root holds a working directory, by path prefix on
 * normalized roots; nested Workspaces resolve to the deepest root. String-only,
 * so the browser half can show the guidance a review would use; the Host
 * resolves the same question with `node:path` (`guidanceFor`).
 * @param entries - stored entries.
 * @param cwd - the review Session's working directory.
 * @returns the entry, or undefined when no root holds the directory.
 */
export function reviewGuidanceEntryFor(
  entries: readonly ReviewGuidanceEntry[],
  cwd: string | undefined,
): ReviewGuidanceEntry | undefined {
  if (cwd === undefined || cwd.length === 0) return undefined
  const target = normalizeWorkspaceRoot(cwd)
  let best: ReviewGuidanceEntry | undefined
  for (const entry of entries) {
    const root = normalizeWorkspaceRoot(entry.root)
    const inside = target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`)
    if (inside && (best === undefined || root.length > normalizeWorkspaceRoot(best.root).length)) best = entry
  }
  return best
}
