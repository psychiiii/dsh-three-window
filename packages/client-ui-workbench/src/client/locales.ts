/** `workbench` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'workbench'

/** Dictionary keys for three-pane Conversation chrome. */
export type WorkbenchKey = keyof typeof zh

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  // Each pane position holds one fixed window kind (left chat, center
  // construct, right review), so the pane chrome names the kind, using the
  // sidebar tags' words.
  'pane.left': '聊天 + Prompt',
  'pane.center': '施工',
  'pane.right': '审核',
  'pane.unbound': '未绑定会话',
  'pane.missing': '找不到会话 {sessionId}',
  'pane.notReady': '会话未就绪',
  'pane.bootstrapFailed': '工作台引导失败：{message}',
}

/** English dictionary. */
export const en: Record<WorkbenchKey, string> = {
  'pane.left': 'Chat + Prompt',
  'pane.center': 'Construct',
  'pane.right': 'Review',
  'pane.unbound': 'No session bound',
  'pane.missing': 'Session {sessionId} is not in the list',
  'pane.notReady': 'Session is not ready',
  'pane.bootstrapFailed': 'Workbench bootstrap failed: {message}',
}
