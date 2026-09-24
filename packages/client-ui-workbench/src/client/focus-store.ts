/**
 * Last Workspace entered, kept in localStorage so a reload resumes it instead
 * of running the project-root fallback again.
 *
 * The value is one Workspace id as a JSON string. A stored id that no longer
 * names a listed Workspace is replaced by the next focus, so a deleted
 * Workspace costs one fallback pass and cannot wedge the page.
 * @module @psychiiii/dsh-three-window-workbench/focus-store
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** localStorage key, shared with every page of this origin. */
export const WORKBENCH_FOCUS_KEY = 'dsh.workbench.focusedWorkspace'

/**
 * Create the focus store. Reading localStorage happens here, so a caller that
 * wants a fresh rehydration calls this after the stored value is in place.
 * @returns store holding the last entered Workspace id, empty when none.
 */
export function createFocusStore(): SnapshotStore<string> {
  return createSnapshotStore<string>('', { persist: { name: WORKBENCH_FOCUS_KEY } })
}
