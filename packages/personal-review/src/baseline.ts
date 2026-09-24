/**
 * Resolve the baseline a review run inspects. File branches go through `ctx.fs`.
 * @module @psychiiii/dsh-three-window-review/baseline
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsObservation, FsTarget } from '@deepseek-ai/dsh-fs'
import { sandboxDenialMarker, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Relative path of an optional construct-window report. */
export const CONSTRUCT_REPORT = '.dsh/construct-report.md'

/** How {@link resolveBaseline} chose the inspected content. */
export type BaselineSource = 'explicit-ref' | 'explicit-path' | 'construct-report' | 'head-diff'

/** Inclusive caps on the resolved baseline body. */
export interface BaselineLimits {
  /** UTF-8 byte length of `body`, inclusive. */
  readonly maxBytes: number
  /** Line count of `body`, inclusive. */
  readonly maxLines: number
}

/**
 * Filesystem operations `resolveBaseline` needs. Matches `ctx.fs` methods the
 * official `read` tool uses, plus `contains` for workspace confinement.
 */
export interface BaselineFs {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  contains(parent: FsTarget, child: FsTarget): boolean
}

/** Inputs for one baseline resolution. */
export interface BaselineRequest {
  /** Session working directory. */
  readonly cwd: string
  /** Optional git ref or file path from the tool argument. */
  readonly explicit?: string
  /** Cancellation from the tool execution. */
  readonly signal: AbortSignal
  /** Host filesystem (`ctx.fs`). */
  readonly fs: BaselineFs
  /** Standing sandbox mode, used in out-of-workspace denials. */
  readonly sandboxMode: SandboxMode
  /** Optional `fs/observed` recorder (official read emits the same event). */
  readonly observe?: (target: FsTarget, observation: FsObservation) => void
}

/** Resolved baseline identity and the text handed to every reviewer. */
export interface ResolvedBaseline {
  /** Id reviewers must echo in `reviewedBaseline`. */
  readonly id: string
  /** Which resolver branch produced this baseline. */
  readonly source: BaselineSource
  /** Body copied into each reviewer prompt. */
  readonly body: string
}

/**
 * Resolution options shared with official filesystem tools: session cwd plus
 * the tool's abort signal. Copied here because `@deepseek-ai/dsh-tool-fs` does
 * not export `sessionResolveOptions` from its public package entry.
 * @param exec - the current tool execution.
 */
export function sessionResolveOptions(
  exec: ToolExecution,
): { cwd?: string; signal?: AbortSignal } {
  const cwd = exec.agent?.session.header.cwd
  return {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
  }
}

function git(cwd: string, args: string[]): { ok: boolean; text: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000 })
  if (result.error !== undefined || result.status !== 0) {
    return { ok: false, text: (result.stderr || result.error?.message || '').trim() }
  }
  return { ok: true, text: (result.stdout ?? '').trim() }
}

function shortHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}

function lineCount(body: string): number {
  if (body.length === 0) return 0
  return body.split(/\r\n|\n|\r/).length
}

/**
 * Fail when the assembled body exceeds either cap. Does not truncate.
 * @param body - resolved baseline text.
 * @param limits - inclusive byte and line caps.
 * @param label - which resolver branch overflowed.
 */
export function assertBaselineSize(body: string, limits: BaselineLimits, label: string): void {
  const bytes = Buffer.byteLength(body, 'utf8')
  const lines = lineCount(body)
  if (bytes > limits.maxBytes) {
    throw new Error(
      `评审基线 ${label} is ${String(bytes)} bytes, over the ${String(limits.maxBytes)} byte limit`,
    )
  }
  if (lines > limits.maxLines) {
    throw new Error(
      `评审基线 ${label} is ${String(lines)} lines, over the ${String(limits.maxLines)} line limit`,
    )
  }
}

function fileBaseline(
  label: string,
  source: BaselineSource,
  content: string,
  limits: BaselineLimits,
): ResolvedBaseline {
  const body = content.length === 0 ? `(empty ${label})` : content
  assertBaselineSize(body, limits, label)
  return {
    id: `${label}@${shortHash(content)}`,
    source,
    body,
  }
}

/**
 * Read one workspace file through `ctx.fs`. Out-of-workspace targets fail as
 * `FS_SANDBOX_DENIED` before stat, so absence of a host path is not leaked.
 * @returns the text and observation target, or `undefined` when the path is
 *   inside the workspace but missing.
 */
async function readWorkspaceFile(
  request: BaselineRequest,
  requested: string,
  limits: BaselineLimits,
): Promise<{ text: string; target: FsTarget; info: FsInfo } | undefined> {
  const opts = { cwd: request.cwd, signal: request.signal }
  const root = await request.fs.resolve('.', opts)
  const target = await request.fs.resolve(requested, opts)
  if (!request.fs.contains(root, target)) {
    throw new FsError(
      `${sandboxDenialMarker(request.sandboxMode)}\n评审基线 ${JSON.stringify(requested)} is outside the session workspace (${target.displayPath})`,
      'FS_SANDBOX_DENIED',
    )
  }
  const info = await request.fs.stat(target, request.signal)
  if (info === undefined) {
    request.observe?.(target, { kind: 'absent' })
    return undefined
  }
  if (info.type !== 'file') {
    throw new Error(`评审基线 ${JSON.stringify(requested)} is not a regular file`)
  }
  if (info.size !== undefined && info.size > limits.maxBytes) {
    throw new Error(
      `评审基线 ${JSON.stringify(requested)} is ${String(info.size)} bytes, over the ${String(limits.maxBytes)} byte limit`,
    )
  }
  const text = await request.fs.readText(target, request.signal)
  request.observe?.(target, { kind: 'present', version: info.version })
  return { text, target, info }
}

/**
 * Resolve the baseline for one review. File and construct-report branches
 * use `ctx.fs.resolve` / `stat` / `readText` with session cwd. Git branches stay
 * in-process `git` with `cwd` set to the session workspace.
 * @param request - session cwd, optional explicit argument, filesystem, signal.
 * @param limits - inclusive body caps applied to every branch.
 */
export async function resolveBaseline(
  request: BaselineRequest,
  limits: BaselineLimits,
): Promise<ResolvedBaseline> {
  const { cwd, explicit } = request
  if (explicit !== undefined && explicit.length > 0) {
    const parsed = git(cwd, ['rev-parse', '--verify', `${explicit}^{commit}`])
    if (parsed.ok) {
      const sha = parsed.text
      const diff = git(cwd, ['diff', sha])
      const stat = git(cwd, ['log', '-1', '--oneline', sha])
      const body = [
        `git commit ${sha}`,
        stat.ok ? stat.text : '',
        diff.ok && diff.text.length > 0 ? diff.text : '(no uncommitted diff against this commit)',
      ].filter(line => line.length > 0).join('\n\n')
      assertBaselineSize(body, limits, `git ${sha}`)
      return { id: sha, source: 'explicit-ref', body }
    }
    const file = await readWorkspaceFile(request, explicit, limits)
    if (file !== undefined) {
      return fileBaseline(`path:${explicit}`, 'explicit-path', file.text, limits)
    }
    throw new Error(
      `评审基线 ${JSON.stringify(explicit)} is not a git commit in ${cwd} and is not a file`,
    )
  }
  const report = await readWorkspaceFile(request, CONSTRUCT_REPORT, limits)
  if (report !== undefined) {
    return fileBaseline('construct-report', 'construct-report', report.text, limits)
  }
  const head = git(cwd, ['rev-parse', 'HEAD'])
  if (!head.ok) {
    throw new Error(
      '评审基线 is missing: pass a git ref or file path, add .dsh/construct-report.md, or run from a git checkout',
    )
  }
  const diff = git(cwd, ['diff', 'HEAD'])
  const cached = git(cwd, ['diff', '--cached'])
  const status = git(cwd, ['status', '--porcelain'])
  const log = git(cwd, ['log', '-1', '--oneline', 'HEAD'])
  const parts = [
    `git HEAD ${head.text}`,
    log.ok ? log.text : '',
    diff.ok && diff.text.length > 0 ? diff.text : '',
    cached.ok && cached.text.length > 0 ? cached.text : '',
    status.ok && status.text.length > 0 ? `status:\n${status.text}` : '',
  ].filter(line => line.length > 0)
  const body = parts.length > 1
    ? parts.join('\n\n')
    : `Working tree matches ${head.text}.`
  assertBaselineSize(body, limits, `git HEAD ${head.text}`)
  return { id: head.text, source: 'head-diff', body }
}
