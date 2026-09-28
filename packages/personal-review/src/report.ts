/**
 * The confirmation the review asks before any reviewer model runs. It never
 * interpolates provider or model names. The report itself is
 * `report-markdown.ts`.
 * @module @psychiiii/dsh-three-window-review/report
 */

import type { MaterialManifestItem, ReviewScopeText } from './types.ts'

/** Inputs for {@link renderConfirmation}. */
export interface ConfirmationInput {
  readonly manifest: readonly MaterialManifestItem[]
  readonly scope: ReviewScopeText
  readonly reviewers: number
  /** UTF-8 bytes of the whole material, and the cap, for the "large" note. */
  readonly bytes: number
  readonly maxBytes: number
  /** The review window's output language tag; Chinese for `zh…`, English otherwise. */
  readonly language?: string
}

/** The three answers the confirmation offers, in each language, in order: start, change, cancel. */
export const CONFIRMATION_OPTIONS = {
  zh: ['开始评审', '换材料或重点', '取消'],
  en: ['Start the review', 'Change the material or focus', 'Cancel'],
} as const

/** Most changed files listed under one version-control item before "… and N more". */
const FILES_SHOWN = 20

/**
 * The question the review asks before any reviewer model runs: the exact
 * material list the controller built, why each item was picked, what was not
 * included and why, and what the reviewers will be asked. What this shows is
 * what runs.
 * @param input - the resolved material and the review's two user layers.
 * @returns the short question and the detail shown under it.
 */
export function renderConfirmation(input: ConfirmationInput): { question: string; detail: string; options: readonly string[] } {
  const zh = (input.language ?? '').startsWith('zh')
  const reason = (status: MaterialManifestItem['status']): string => {
    if (zh) return status === 'not-text' ? '不是文本文件' : status === 'too-large' ? '文件太大' : '超出这次评审的大小或数量上限'
    return status === 'not-text' ? 'not a text file' : status === 'too-large' ? 'too large' : 'over this review’s size or file limit'
  }
  const lines: string[] = []
  lines.push(zh ? `**将由 ${String(input.reviewers)} 个评审模型评审：**` : `**To be reviewed by ${String(input.reviewers)} reviewer model(s):**`)
  for (const item of input.manifest) {
    if (item.status !== 'included') {
      lines.push(zh ? `- ~~${item.source}~~ 未纳入：${reason(item.status)}` : `- ~~${item.source}~~ not included: ${reason(item.status)}`)
      continue
    }
    const size = item.totalLines !== undefined
      ? (zh ? `只取前 ${String(item.lines ?? 0)} 行，共 ${String(item.totalLines)} 行` : `first ${String(item.lines ?? 0)} of ${String(item.totalLines)} lines`)
      : (zh ? `${String(item.lines ?? 0)} 行` : `${String(item.lines ?? 0)} lines`)
    // The path and its size on one line, the reason on the next (a Markdown
    // hard break): run together, a long reason wraps the path's line raggedly.
    lines.push(`- \`${item.source}\` · ${size}${item.why === undefined ? '' : `\\\n  ${item.why}`}`)
    if (item.files !== undefined && item.files.length > 0) {
      const shown = item.files.slice(0, FILES_SHOWN).map(file => `\`${file}\``).join(zh ? '、' : ', ')
      const more = item.files.length > FILES_SHOWN ? (zh ? ` 等共 ${String(item.files.length)} 个文件` : ` and ${String(item.files.length - FILES_SHOWN)} more`) : ''
      lines.push(zh ? `  - 涉及：${shown}${more}` : `  - touches: ${shown}${more}`)
    }
  }
  const request = input.scope.request.trim()
  const guidance = input.scope.guidance.trim()
  lines.push('')
  lines.push(zh ? `**这次要看**：${request.length === 0 ? '未指定，整体评审' : request}` : `**This time:** ${request.length === 0 ? 'no focus named; the material as a whole' : request}`)
  lines.push('')
  lines.push(zh
    ? `**评审口径**：${input.scope.guidanceSource === 'none' ? '未设置，只按内置的通用标准' : `${guidance}（${input.scope.guidanceSource === 'workspace' ? '本工作区' : '默认'}）`}`
    : `**Standing guidance:** ${input.scope.guidanceSource === 'none' ? 'none; built-in general criteria only' : `${guidance} (${input.scope.guidanceSource === 'workspace' ? 'this workspace' : 'default'})`}`)
  if (input.bytes > input.maxBytes / 2) {
    lines.push('')
    lines.push(zh ? '材料较大，较慢的评审模型可能要跑比较久。' : 'The material is large; slower reviewer models may take a while.')
  }
  lines.push('')
  lines.push(zh ? '选「开始评审」后才会调用评审模型。' : 'No reviewer model is called until “Start the review”.')
  return {
    question: zh ? '按下面的清单开始评审？' : 'Start the review on this list?',
    detail: lines.join('\n'),
    options: zh ? CONFIRMATION_OPTIONS.zh : CONFIRMATION_OPTIONS.en,
  }
}
