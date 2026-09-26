/**
 * Per-Workspace turn prompt: text the user sets for one Workspace, appended
 * to every user turn of the three windows whose working directory lies in it.
 *
 * Entries are keyed by the Workspace's root path rather than its id: the Host
 * sees only a Session's working directory when it appends, a rename leaves the
 * path alone, and a Workspace removed and added again at the same path keeps
 * its prompt. The rule that explains the wrapper is fixed text in each preset's
 * persona suffix, next to the output-language rule.
 * @module @psychiiii/dsh-three-window-review/workspace-prompt
 */

/** Longest prompt one Workspace may hold, in UTF-16 code units (what the text box counts). */
export const WORKSPACE_PROMPT_MAX = 4000

/** Most Workspaces that may hold a prompt at once. */
export const WORKSPACE_PROMPT_ENTRIES_MAX = 200

/** One Workspace's prompt as stored. */
export interface WorkspacePromptEntry {
  /** The Workspace's root path, as the Workspace list reports it. */
  readonly root: string
  /** The text, verbatim. */
  readonly prompt: string
}

/**
 * A root path in the form entries are compared by: forward slashes on a
 * Windows path, no trailing separator (except a bare root).
 * @param root - a Workspace root path.
 * @returns the comparable form.
 */
export function normalizeWorkspaceRoot(root: string): string {
  const windows = /^[A-Za-z]:[/\\]/u.test(root) || root.startsWith('\\\\')
  const slashed = windows ? root.replaceAll('\\', '/') : root
  const trimmed = slashed.replace(/\/+$/u, '')
  if (trimmed.length === 0) return '/'
  return /^[A-Za-z]:$/u.test(trimmed) ? `${trimmed}/` : trimmed
}

/**
 * Read the stored entries out of a section, tolerating anything: entries that
 * are not a root plus a non-blank prompt within the limit are dropped, and a
 * later entry for the same root replaces an earlier one.
 * @param section - the `personal-settings` Config section, or any object.
 * @returns the usable entries, in stored order.
 */
export function workspacePromptsFromSection(section: unknown): WorkspacePromptEntry[] {
  const raw = section !== null && typeof section === 'object' && !Array.isArray(section)
    ? (section as { workspacePrompts?: unknown }).workspacePrompts
    : undefined
  if (!Array.isArray(raw)) return []
  const byRoot = new Map<string, WorkspacePromptEntry>()
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const { root, prompt } = item as { root?: unknown; prompt?: unknown }
    if (typeof root !== 'string' || root.length === 0 || typeof prompt !== 'string') continue
    if (prompt.trim().length === 0 || prompt.length > WORKSPACE_PROMPT_MAX) continue
    const key = normalizeWorkspaceRoot(root)
    byRoot.delete(key)
    byRoot.set(key, { root: key, prompt })
  }
  return [...byRoot.values()]
}

/**
 * The entries after setting one Workspace's prompt; blank text removes it.
 * @param entries - current entries.
 * @param root - the Workspace's root path.
 * @param prompt - the new text.
 * @returns the next entries.
 * @throws when the text is over {@link WORKSPACE_PROMPT_MAX} or the table would exceed
 *   {@link WORKSPACE_PROMPT_ENTRIES_MAX} entries.
 */
export function withWorkspacePrompt(
  entries: readonly WorkspacePromptEntry[],
  root: string,
  prompt: string,
): WorkspacePromptEntry[] {
  if (prompt.length > WORKSPACE_PROMPT_MAX) {
    throw new Error(`the workspace prompt is ${String(prompt.length)} characters; the limit is ${String(WORKSPACE_PROMPT_MAX)}`)
  }
  const key = normalizeWorkspaceRoot(root)
  const rest = entries.filter(entry => normalizeWorkspaceRoot(entry.root) !== key)
  if (prompt.trim().length === 0) return rest
  if (rest.length >= WORKSPACE_PROMPT_ENTRIES_MAX) {
    throw new Error(`at most ${String(WORKSPACE_PROMPT_ENTRIES_MAX)} workspaces can hold a prompt`)
  }
  return [...rest, { root: key, prompt }]
}

/**
 * The text a model receives for one Workspace's prompt.
 * @param prompt - the stored text.
 * @returns the wrapped block, or undefined for blank text.
 */
export function workspacePromptBlock(prompt: string | undefined): string | undefined {
  if (prompt === undefined || prompt.trim().length === 0) return undefined
  return `<workspace-instructions>\n${prompt}\n</workspace-instructions>`
}

/**
 * The fixed rule the window presets carry after the output-language rule.
 * Kept here so a test can hold the presets to the same wording.
 */
export const WORKSPACE_PROMPT_RULE =
  'A user turn may also carry <workspace-instructions>: standing instructions the user set for this workspace. '
  + 'Follow them as the user\'s own instructions; when the user\'s message says otherwise, the message wins.'

/**
 * A rough token count for the editor's hint: one per CJK character, one per
 * four other characters. It is a hint, not a bill.
 * @param text - the prompt text.
 * @returns the estimate, never below zero.
 */
export function estimateTurnTokens(text: string): number {
  let cjk = 0
  for (const char of text) {
    if (/[぀-ヿ㐀-鿿가-힯豈-﫿]/u.test(char)) cjk += 1
  }
  const other = [...text].length - cjk
  return cjk + Math.ceil(other / 4)
}
