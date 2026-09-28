/**
 * Resolve what a review looks at: the files, folders, git revisions, or work
 * report the user asked for, read once and frozen into one body every seat
 * receives, with a manifest the user confirms before any reviewer model runs.
 *
 * Nothing here assumes the material is code or that a baseline exists. A file
 * that is not text, or too large, is listed as not included rather than read,
 * so a media or office project still sees what the reviewers could not see.
 * Files go through `ctx.fs`, confined to the session's workspace; git is one
 * source among others and is used only when the entry is not a path there.
 * @module @psychiiii/dsh-three-window-review/material
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsObservation, FsTarget } from '@deepseek-ai/dsh-fs'
import { sandboxDenialMarker, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { MaterialManifestItem } from './types.ts'

export { renderManifest } from './manifest.ts'

/** The work report a construct window may leave; reviewed when nothing else is named. */
export const WORK_REPORT = '.dsh/construct-report.md'

/** Most files one review takes; a folder beyond this is listed as over the limit. */
export const MAX_MATERIAL_FILES = 60

/** Folder entries never walked into: version-control and dependency trees. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.hg', '.svn'])

/** Inclusive caps on the assembled material. */
export interface MaterialLimits {
  /** UTF-8 bytes of all included text together; also the cap on one file. */
  readonly maxBytes: number
  /** Lines of all included text together. */
  readonly maxLines: number
}

/** The `ctx.fs` operations material resolution uses. */
export interface MaterialFs {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
  contains(parent: FsTarget, child: FsTarget): boolean
}

/** Inputs for one resolution. */
export interface MaterialRequest {
  /** Session working directory: the workspace every path is confined to. */
  readonly cwd: string
  /**
   * What was picked: workspace paths, folders, or version-control revisions,
   * each with an optional reason the user sees. Empty or absent: the latest
   * work (the work report, else the uncommitted changes).
   */
  readonly entries?: readonly MaterialEntry[]
  readonly signal: AbortSignal
  readonly fs: MaterialFs
  /** Standing sandbox mode, named in out-of-workspace denials. */
  readonly sandboxMode: SandboxMode
  /** `fs/observed` recorder, as the official read tool emits it. */
  readonly observe?: (target: FsTarget, observation: FsObservation) => void
}

/** One picked item and why it was picked. */
export interface MaterialEntry {
  readonly source: string
  readonly why?: string
}

/** The frozen material. */
export interface ResolvedMaterial {
  /** Fingerprint of every included item; seats echo it, and a confirmation must match it. */
  readonly id: string
  /** One row per item, included or not, in order. */
  readonly manifest: readonly MaterialManifestItem[]
  /** Included items, each under a `=== M1 source ===` header. */
  readonly body: string
}

interface Candidate {
  readonly source: string
  readonly text?: string
  readonly status: MaterialManifestItem['status']
  readonly why?: string
  readonly files?: readonly string[]
}

/** Git's empty tree: the "parent" of a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function changedFiles(cwd: string, args: string[]): string[] {
  const out = git(cwd, ['diff', '--name-only', ...args])
  return out.ok && out.text.length > 0 ? out.text.split('\n') : []
}

function git(cwd: string, args: string[]): { ok: boolean; text: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000 })
  if (result.error !== undefined || result.status !== 0) {
    return { ok: false, text: (result.stderr || result.error?.message || '').trim() }
  }
  return { ok: true, text: (result.stdout ?? '').trim() }
}

function isCommit(cwd: string, rev: string): boolean {
  return rev.length > 0 && !rev.startsWith('-') && git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).ok
}

/**
 * A version-control revision or range as material, when the workspace is a
 * repository. `A..B` is what changed from A to B; a single revision is what
 * that commit itself changed (against its parent; a root commit against
 * nothing) — what a person means by "review this commit".
 * @returns the candidate, or undefined when the entry is not a revision here.
 */
function gitCandidate(cwd: string, spec: string): Candidate | undefined {
  const range = /^([^.\s]+)\.\.\.?([^.\s]+)$/u.exec(spec)
  if (range !== null) {
    const [, from, to] = range as unknown as [string, string, string]
    if (!isCommit(cwd, from) || !isCommit(cwd, to)) return undefined
    const log = git(cwd, ['log', '--oneline', spec])
    const diff = git(cwd, ['diff', spec])
    const text = [log.ok ? log.text : '', diff.ok && diff.text.length > 0 ? diff.text : '(no differences)']
      .filter(part => part.length > 0).join('\n\n')
    return { source: `git ${spec}`, text, status: 'included', files: changedFiles(cwd, [spec]) }
  }
  if (!isCommit(cwd, spec)) return undefined
  const parent = isCommit(cwd, `${spec}^`) ? `${spec}^` : EMPTY_TREE
  const log = git(cwd, ['log', '-1', '--format=%h %s%n%n%b', spec])
  const diff = git(cwd, ['diff', parent, spec])
  const text = [log.ok ? log.text.trim() : '', diff.ok && diff.text.length > 0 ? diff.text : '(this commit changes no file content)']
    .filter(part => part.length > 0).join('\n\n')
  return { source: `git ${spec}`, text, status: 'included', files: changedFiles(cwd, [parent, spec]) }
}

/** Uncommitted changes against HEAD, staged or not; undefined outside a repository. */
function gitWorkingChanges(cwd: string): Candidate | undefined {
  const head = git(cwd, ['rev-parse', 'HEAD'])
  if (!head.ok) return undefined
  const log = git(cwd, ['log', '-1', '--oneline', 'HEAD'])
  const diff = git(cwd, ['diff', 'HEAD'])
  const status = git(cwd, ['status', '--porcelain'])
  const parts = [
    log.ok ? log.text : `HEAD ${head.text}`,
    diff.ok && diff.text.length > 0 ? diff.text : '',
    status.ok && status.text.length > 0 ? `status:\n${status.text}` : '',
  ].filter(part => part.length > 0)
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard'])
  const files = [...new Set([
    ...changedFiles(cwd, ['HEAD']),
    ...untracked.ok && untracked.text.length > 0 ? untracked.text.split('\n') : [],
  ])]
  return {
    source: 'git uncommitted changes',
    text: parts.length > 1 ? parts.join('\n\n') : `The working tree matches ${head.text}.`,
    status: 'included',
    files,
  }
}

/** The workspace-relative form of a target, for the manifest. */
function relativeSource(root: FsTarget, target: FsTarget): string {
  const base = root.displayPath.replace(/[\\/]+$/u, '')
  const path = target.displayPath
  if (path === base) return '.'
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`) ? path.slice(base.length + 1) : path
}

/**
 * Read one file as a candidate. A file over the byte cap is not read, and one
 * `ctx.fs` rejects as not text is listed rather than failing the review.
 */
async function fileCandidate(
  request: MaterialRequest,
  root: FsTarget,
  target: FsTarget,
  info: FsInfo,
  limits: MaterialLimits,
): Promise<Candidate> {
  const source = relativeSource(root, target)
  if (info.size !== undefined && info.size > limits.maxBytes) return { source, status: 'too-large' }
  try {
    const text = await request.fs.readText(target, request.signal)
    request.observe?.(target, { kind: 'present', version: info.version })
    return { source, text, status: 'included' }
  } catch (error) {
    if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return { source, status: 'not-text' }
    if (error instanceof FsError && error.code === 'FS_TOO_LARGE') return { source, status: 'too-large' }
    throw error
  }
}

/** Every file under a folder, depth first in listing order, skipping hidden and dependency folders. */
async function folderFiles(
  request: MaterialRequest,
  folder: FsTarget,
  out: { target: FsTarget; info: FsInfo }[],
  cap: number,
): Promise<number> {
  let beyond = 0
  for (const entry of await request.fs.listDir(folder, request.signal)) {
    if (entry.type === 'directory') {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue
      beyond += await folderFiles(request, entry.target, out, cap)
      continue
    }
    if (entry.type !== 'file') continue
    if (out.length >= cap) {
      beyond += 1
      continue
    }
    out.push({
      target: entry.target,
      info: { type: 'file', ...entry.size !== undefined ? { size: entry.size } : {}, ...entry.version !== undefined ? { version: entry.version } : {} } as FsInfo,
    })
  }
  return beyond
}

async function entryCandidates(
  request: MaterialRequest,
  root: FsTarget,
  picked: MaterialEntry,
  limits: MaterialLimits,
  budget: { files: number },
): Promise<Candidate[]> {
  const why = picked.why?.trim()
  const withWhy = (candidate: Candidate): Candidate => (why === undefined || why.length === 0 ? candidate : { ...candidate, why })
  return (await entryCandidatesRaw(request, root, picked.source.trim(), limits, budget)).map(withWhy)
}

async function entryCandidatesRaw(
  request: MaterialRequest,
  root: FsTarget,
  entry: string,
  limits: MaterialLimits,
  budget: { files: number },
): Promise<Candidate[]> {
  const opts = { cwd: request.cwd, signal: request.signal }
  const target = await request.fs.resolve(entry, opts)
  if (!request.fs.contains(root, target)) {
    throw new FsError(
      `${sandboxDenialMarker(request.sandboxMode)}\nreview material ${JSON.stringify(entry)} is outside the session workspace (${target.displayPath})`,
      'FS_SANDBOX_DENIED',
    )
  }
  const info = await request.fs.stat(target, request.signal)
  if (info === undefined) {
    request.observe?.(target, { kind: 'absent' })
    const revision = gitCandidate(request.cwd, entry)
    if (revision !== undefined) return [revision]
    throw new Error(`review material ${JSON.stringify(entry)} is not a file or folder in the workspace, nor a version-control revision there`)
  }
  if (info.type === 'file') {
    if (budget.files <= 0) return [{ source: relativeSource(root, target), status: 'over-limit' }]
    budget.files -= 1
    return [await fileCandidate(request, root, target, info, limits)]
  }
  if (info.type !== 'directory') {
    throw new Error(`review material ${JSON.stringify(entry)} is neither a regular file nor a folder`)
  }
  const files: { target: FsTarget; info: FsInfo }[] = []
  const beyond = await folderFiles(request, target, files, budget.files)
  budget.files -= files.length
  const candidates: Candidate[] = []
  for (const file of files) candidates.push(await fileCandidate(request, root, file.target, file.info, limits))
  if (beyond > 0) {
    const folder = relativeSource(root, target)
    candidates.push({ source: `${folder === '.' ? '' : `${folder}/`}… ${String(beyond)} more file(s)`, status: 'over-limit' })
  }
  if (candidates.length === 0) throw new Error(`review material ${JSON.stringify(entry)} is a folder with no files`)
  return candidates
}

/** Lines of text; a final line break ends the last line rather than starting another. */
function lineCount(text: string): number {
  if (text.length === 0) return 0
  const parts = text.split(/\r\n|\n|\r/u).length
  return /(?:\r\n|\n|\r)$/u.test(text) ? parts - 1 : parts
}

/** The longest prefix of whole lines within both caps. */
function cut(text: string, maxLines: number, maxBytes: number): string {
  const lines = text.split(/(?<=\n)/u).slice(0, maxLines)
  let out = ''
  for (const line of lines) {
    if (Buffer.byteLength(out + line, 'utf8') > maxBytes) break
    out += line
  }
  return out
}

/**
 * Resolve and freeze the material for one review.
 * @param request - workspace, entries, filesystem, signal.
 * @param limits - byte and line caps on the whole material.
 * @returns the fingerprinted material with its manifest.
 * @throws when an entry is outside the workspace or names nothing, or when nothing was named and there is neither a work report nor a git repository.
 */
export async function resolveMaterial(request: MaterialRequest, limits: MaterialLimits): Promise<ResolvedMaterial> {
  const root = await request.fs.resolve('.', { cwd: request.cwd, signal: request.signal })
  const entries = (request.entries ?? []).filter(entry => entry.source.trim().length > 0)
  const candidates: Candidate[] = []
  const budget = { files: MAX_MATERIAL_FILES }
  if (entries.length > 0) {
    const seen = new Set<string>()
    for (const entry of entries) {
      for (const candidate of await entryCandidates(request, root, entry, limits, budget)) {
        if (seen.has(candidate.source)) continue
        seen.add(candidate.source)
        candidates.push(candidate)
      }
    }
  } else {
    const report = await request.fs.resolve(WORK_REPORT, { cwd: request.cwd, signal: request.signal })
    const info = await request.fs.stat(report, request.signal)
    const fallback = info?.type === 'file'
      ? await fileCandidate(request, root, report, info, limits)
      : gitWorkingChanges(request.cwd)
    if (fallback === undefined) {
      throw new Error('nothing was picked, and the workspace has neither a work report nor version-controlled changes: pick material from what the user said, or ask them')
    }
    candidates.push(fallback)
  }

  const manifest: MaterialManifestItem[] = []
  const blocks: string[] = []
  const hash = createHash('sha256')
  let bytesLeft = limits.maxBytes
  let linesLeft = limits.maxLines
  let index = 0
  for (const candidate of candidates) {
    if (candidate.status !== 'included' || candidate.text === undefined) {
      manifest.push({
        label: '-', source: candidate.source, status: candidate.status,
        ...candidate.why !== undefined ? { why: candidate.why } : {},
      })
      continue
    }
    const totalLines = lineCount(candidate.text)
    const fits = Buffer.byteLength(candidate.text, 'utf8') <= bytesLeft && totalLines <= linesLeft
    const text = fits ? candidate.text : cut(candidate.text, linesLeft, bytesLeft)
    if (text.length === 0 && candidate.text.length > 0) {
      manifest.push({ label: '-', source: candidate.source, status: 'over-limit' })
      continue
    }
    index += 1
    const label = `M${String(index)}`
    const bytes = Buffer.byteLength(text, 'utf8')
    const lines = lineCount(text)
    bytesLeft -= bytes
    linesLeft -= lines
    manifest.push({
      label, source: candidate.source, status: 'included', bytes, lines,
      ...fits ? {} : { totalLines },
      ...candidate.why !== undefined ? { why: candidate.why } : {},
      ...candidate.files !== undefined ? { files: candidate.files } : {},
    })
    hash.update(`${candidate.source}\0${text}\0`)
    blocks.push(`=== ${label} ${candidate.source} ===\n${text.length === 0 ? '(empty)' : text}\n=== end of ${label} ===`)
  }
  if (index === 0) {
    const reasons = manifest.map(item => `${item.source}: ${item.status}`).join('; ')
    throw new Error(`none of the named material can be reviewed as text (${reasons}): ask the user for text files`)
  }
  return {
    id: `material@${hash.digest('hex').slice(0, 12)}`,
    manifest,
    body: blocks.join('\n\n'),
  }
}

/**
 * Resolution options shared with official filesystem tools: session cwd plus
 * the tool's abort signal.
 * @param exec - the current tool execution.
 * @param exec.agent - its owning agent, if any.
 * @param exec.signal - its abort signal.
 * @returns the options.
 */
export function sessionResolveOptions(
  exec: { agent?: { session: { header: { cwd?: string } } }; signal: AbortSignal },
): { cwd?: string; signal?: AbortSignal } {
  const cwd = exec.agent?.session.header.cwd
  return {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
  }
}
