/**
 * Three ordinary Conversation windows. Window identity is the bound Session,
 * never a pane id.
 * @module @psychiiii/dsh-three-window-workbench/windows
 */

/** One bound Conversation window. */
export interface WorkbenchWindow {
  /** Ordinary Session this window displays. */
  readonly sessionId: string
  /** Tab title. */
  readonly title: string
}

/** Left-to-right pane role used for visible chrome. */
export type WorkbenchPaneRole = 'left' | 'center' | 'right'

/** Left-to-right role names matching pane indexes 0, 1, 2. */
export const WORKBENCH_PANE_ROLES: readonly WorkbenchPaneRole[] = ['left', 'center', 'right']
