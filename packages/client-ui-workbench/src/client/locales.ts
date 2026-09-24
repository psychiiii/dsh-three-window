/** `workbench` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'workbench'

/** Dictionary keys for three-pane Conversation chrome. */
export type WorkbenchKey = keyof typeof zh

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'pane.left': '左',
  'pane.center': '中',
  'pane.right': '右',
  'pane.unbound': '未绑定会话',
  'pane.missing': '找不到会话 {sessionId}',
  'pane.notReady': '会话未就绪',
  'pane.bootstrapFailed': '工作台引导失败：{message}',
}

/** English dictionary. */
export const en: Record<WorkbenchKey, string> = {
  'pane.left': 'Left',
  'pane.center': 'Center',
  'pane.right': 'Right',
  'pane.unbound': 'No session bound',
  'pane.missing': 'Session {sessionId} is not in the list',
  'pane.notReady': 'Session is not ready',
  'pane.bootstrapFailed': 'Workbench bootstrap failed: {message}',
}
