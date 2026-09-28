/**
 * The material manifest as text. Pure, so the prompt builders and the browser
 * half can use it without the Host-only resolver.
 * @module @psychiiii/dsh-three-window-review/manifest
 */

import type { MaterialManifestItem } from './types.ts'

/**
 * The manifest as the seats and the user read it.
 * @param manifest - resolved manifest rows.
 * @returns one line per row.
 */
export function renderManifest(manifest: readonly MaterialManifestItem[]): string {
  return manifest.map((item) => {
    if (item.status !== 'included') {
      const why = item.status === 'not-text' ? 'not text' : item.status === 'too-large' ? 'too large' : 'over the size limit'
      return `  -   ${item.source}  (not included: ${why})`
    }
    const size = `${String(item.bytes ?? 0)} bytes, ${String(item.lines ?? 0)} lines`
    const cutNote = item.totalLines !== undefined ? `; cut to the first ${String(item.lines ?? 0)} of ${String(item.totalLines)} lines` : ''
    const files = item.files !== undefined && item.files.length > 0 ? `\n        touches: ${item.files.slice(0, 40).join(', ')}${item.files.length > 40 ? `, … ${String(item.files.length - 40)} more` : ''}` : ''
    return `  ${item.label.padEnd(3)} ${item.source}  (${size}${cutNote})${files}`
  }).join('\n')
}
