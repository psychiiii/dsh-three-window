/**
 * Host plugin: `review_debate` plus the `personalReview` session projection.
 * @module @psychiiii/dsh-three-window-review
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveMaterial } from './material.ts'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { assertGrouping, assertMaxRounds, assertNoModelOverride, selectReviewers } from './args.ts'
import { completeSeat } from './complete.ts'
import { runDebate, type DebateSeat } from './debate.ts'
import { resolveReviewerModels } from './resolve.ts'
import {
  REVIEW_PRESET, REVIEW_SETTINGS_ENTRY, perspectiveFromSection, requireConfiguredReviewers,
  reviewersFromSection,
} from './reviewers.ts'
import { renderConfirmation } from './report.ts'
import type { MaterialEntry } from './material.ts'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { ReviewGuidanceEntry } from './review-guidance.ts'
import type {} from './settings.ts'
import { foldPanel, initialPanel, panelStateSchema } from './panel.ts'
import {
  MAX_DEBATE_ROUNDS,
  type GroupingMode, type ReviewPanelState, type ReviewScopeText,
} from './types.ts'

export type * from './types.ts'
export { resolveMaterial, renderManifest, sessionResolveOptions, WORK_REPORT, MAX_MATERIAL_FILES } from './material.ts'
export type { MaterialEntry, MaterialFs, MaterialLimits, MaterialRequest, ResolvedMaterial } from './material.ts'
export {
  assertNoModelOverride, assertMaxRounds, assertGrouping, selectReviewers,
  FORBIDDEN_REVIEW_DEBATE_KEYS,
} from './args.ts'
export { resolveReviewerModels } from './resolve.ts'
export { parseSeatJson, unwrapFence } from './parse.ts'
export { normalizeEvidence, findingKey, mergeFindings, labelFindings } from './findings.ts'
export { conclusionsChanged, snapshotConclusions, terminalState, uniqueModelCount } from './converge.ts'
export { readSeatText, completeSeat, buildSeatGenerateOptions } from './complete.ts'
export { runDebate } from './debate.ts'
export { renderConfirmation, CONFIRMATION_OPTIONS } from './report.ts'
export {
  citedFindingIds, dropoutCause, findingIds, isChinese, renderReportMarkdown, runStatusOf,
  type ReportAudience, type ReportSource,
} from './report-markdown.ts'
export { foldPanel, initialPanel, panelReportSchema, panelStateSchema, type PanelEvent } from './panel.ts'
export {
  GROUPING_SYSTEM_PROMPT, checkGrouping, groupFindings, groupingItems, groupingUserPrompt, namesDifferentSources,
  toFindingGroups, type CheckedGrouping, type GroupingCompleter, type GroupingItem, type GroupingResult,
} from './grouping.ts'
export {
  DEBATE_SYSTEM_PROMPT, buildInitialUserPrompt, buildChallengeUserPrompt, type ReviewAsk,
} from './prompts.ts'
export {
  EMPTY_REVIEWERS_MESSAGE, MAX_REVIEWERS, REVIEW_PRESET, REVIEW_SETTINGS_ENTRY,
  assertReviewerTable, perspectiveFromSection, requireConfiguredReviewers, reviewersFromSection,
  parseReviewerRow, toReviewerSpecs, validReviewerRows,
  type ReviewSettings, type ReviewerSettingsRow,
} from './reviewers.ts'
export {
  OutputLanguageSchema, OutputLanguageValueSchema, WorkspacePromptsSchema,
  ReviewSettingsConfig, ReviewerTableSchema, provideReviewSettings,
  type ReviewSettingsService,
} from './settings.ts'
export * from './output-language.ts'
export * from './workspace-prompt.ts'
export * from './review-guidance.ts'

export const name = 'personal-review'
export const inject = ['tools', 'sessionProjections', 'llm', 'fs']

/** Plugin config: seat concurrency, per-call timeout, token cap, and baseline caps. */
export interface Config {
  /** Concurrent seat-call cap inside one round. */
  maxParallel: number
  /** Overall cap on one seat call in ms, however much it is producing. */
  timeoutMs: number
  /** Abort a seat only after this many ms without any output; `0` never. */
  idleTimeoutMs: number
  /** Inclusive UTF-8 byte cap on the resolved baseline body. */
  maxBaselineBytes: number
  /** Inclusive line cap on the resolved baseline body. */
  maxBaselineLines: number
  /** Default round cap, 1..{@link MAX_DEBATE_ROUNDS}. */
  maxRounds: number
  /**
   * Per-seat output cap for `ctx.llm.stream()`. `0` omits `maxTokens` so the
   * adapter materializes `defaultMaxTokens`.
   */
  maxTokens: number
  /** Finding merge mode. */
  grouping: GroupingMode
}

export const Config: z<Config> = z.object({
  maxParallel: z.number().default(3),
  timeoutMs: z.number().default(1_800_000),
  idleTimeoutMs: z.number().default(120_000),
  maxBaselineBytes: z.number().default(262_144),
  maxBaselineLines: z.number().default(8_000),
  maxRounds: z.number().default(MAX_DEBATE_ROUNDS),
  maxTokens: z.number().default(0),
  grouping: z.union([z.const('evidence+claim' as const), z.const('evidence' as const)]).default('evidence'),
})


/** What the coordinator reads about `review_debate`; a spec holds it free of field-specific words. */
export const REVIEW_DEBATE_DESCRIPTION =
  'Anonymous multi-model review of material picked from what the user said, at most 3 rounds. '
  + 'Pass material (what to review, each with why it was picked) and focus (what the user asked to be '
  + 'looked at, in their words). The tool builds the exact list and asks the user itself, in a dialog, '
  + 'before any reviewer model runs; it runs only if the user starts it. If the user asks for other material '
  + 'or another focus, their words come back in the result: pick again and call again. '
  + 'Material items are workspace paths, folders, or version-control revisions: a single revision such as '
  + '"HEAD" is what that commit changed, "A..B" what changed between two revisions. Omit material for the '
  + 'latest work: the work report, else the changes not yet recorded in version control. '
  + 'Reviewer models come from the Review models settings; model, provider, agentOptions, maxTokens, '
  + 'temperature, callTimeoutMs, and other seat-call overrides are errors. Optional: roles (subset of '
  + 'configured reviewer roles), maxRounds 1–3, grouping "evidence+claim" or "evidence".'

/**
 * The standing guidance in force for a working directory: the deepest
 * Workspace root that holds it, else the default, else none.
 * @param cwd - the review Session's working directory.
 * @param entries - stored per-Workspace guidance.
 * @param fallback - the default guidance (the historical perspective setting).
 * @returns the text and where it came from.
 */
export function guidanceFor(
  cwd: string,
  entries: readonly ReviewGuidanceEntry[],
  fallback: string,
): Pick<ReviewScopeText, 'guidance' | 'guidanceSource'> {
  const target = resolvePath(cwd)
  let best: ReviewGuidanceEntry | undefined
  let bestLength = -1
  for (const entry of entries) {
    const root = resolvePath(entry.root)
    const inside = relative(root, target)
    if (inside.startsWith('..') || isAbsolute(inside)) continue
    if (root.length > bestLength) {
      best = entry
      bestLength = root.length
    }
  }
  if (best !== undefined) return { guidance: best.text, guidanceSource: 'workspace' }
  return fallback.trim().length > 0
    ? { guidance: fallback, guidanceSource: 'default' }
    : { guidance: '', guidanceSource: 'none' }
}

/**
 * The picked material as the tool received it: `{ source, why }` objects, or
 * bare strings from a coordinator that left the reason out.
 * @param value - the `material` argument.
 * @returns the entries, empty when absent.
 */
function materialEntries(value: unknown): MaterialEntry[] {
  if (value === undefined) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map((item) => {
    if (typeof item === 'string') return { source: item }
    if (item !== null && typeof item === 'object' && typeof (item as { source?: unknown }).source === 'string') {
      const { source, why } = item as { source: string; why?: unknown }
      return typeof why === 'string' && why.trim().length > 0 ? { source, why: why.trim() } : { source }
    }
    throw new Error('review_debate material items are { source, why } with source a workspace path, folder, or version-control revision')
  })
}

/**
 * Fail at load when a Config field is out of range. Values are never truncated.
 * @param config - plugin config after schemastery defaults.
 */
export function assertPluginConfig(config: Config): void {
  if (!Number.isInteger(config.maxParallel) || config.maxParallel < 1) {
    throw new Error('personal-review config.maxParallel must be a positive integer')
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1) {
    throw new Error('personal-review config.timeoutMs must be a positive integer')
  }
  if (!Number.isInteger(config.idleTimeoutMs) || config.idleTimeoutMs < 0) {
    throw new Error('personal-review config.idleTimeoutMs must be a non-negative integer (0 never aborts for silence)')
  }
  if (!Number.isInteger(config.maxBaselineBytes) || config.maxBaselineBytes < 1) {
    throw new Error('personal-review config.maxBaselineBytes must be a positive integer')
  }
  if (!Number.isInteger(config.maxBaselineLines) || config.maxBaselineLines < 1) {
    throw new Error('personal-review config.maxBaselineLines must be a positive integer')
  }
  if (!Number.isInteger(config.maxTokens) || config.maxTokens < 0) {
    throw new Error('personal-review config.maxTokens must be a non-negative integer (0 omits the adapter cap)')
  }
  assertMaxRounds(config.maxRounds, config.maxRounds)
  assertGrouping(config.grouping, config.grouping)
}

function toSeats(specs: readonly { role: string; provider: string; model: string; reasoningEffort?: string }[]): DebateSeat[] {
  return specs.map((spec, index) => ({
    seatId: `seat-${String(index + 1)}`,
    role: spec.role,
    provider: spec.provider,
    model: spec.model,
    ...spec.reasoningEffort !== undefined ? { reasoningEffort: spec.reasoningEffort } : {},
  }))
}

/**
 * Register the settings namespace, the projection, and `review_debate`.
 * @param ctx - host context.
 * @param config - seat concurrency and caps; reviewer models are read from settings.
 */
export function apply(ctx: Context, config: Config): void {
  assertPluginConfig(config)
  const maxParallel = config.maxParallel
  const timeoutMs = config.timeoutMs
  const idleTimeoutMs = config.idleTimeoutMs
  const maxBaselineBytes = config.maxBaselineBytes
  const maxBaselineLines = config.maxBaselineLines
  const defaultMaxRounds = config.maxRounds
  const maxTokens = config.maxTokens
  const defaultGrouping = config.grouping

  ctx.sessionProjections.register<'personalReview', ReviewPanelState>({
    key: 'personalReview',
    stateVersion: 4,
    stateSchema: panelStateSchema,
    init: initialPanel,
    apply: (state, event) => foldPanel(state, event),
    wire: { viewSchema: panelStateSchema, view: state => state },
  })

  ctx.tools.register(defineTool({
    name: 'review_debate',
    description: REVIEW_DEBATE_DESCRIPTION,
    parameters: {
      material: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string', required: true, description: 'Workspace path or folder, or a version-control revision or range.' },
            why: { type: 'string', description: 'Why this was picked, in a few words the user reads in the dialog.' },
          },
        },
        description: 'What to review. Omit for the latest work.',
      },
      focus: {
        type: 'string',
        description: 'What the user asked to be looked at this time, in their words. Omit when they named nothing.',
      },
      roles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Subset of configured reviewer roles. Omit to run every configured reviewer.',
      },
      maxRounds: {
        type: 'integer',
        description: 'Round cap 1–3. Omit to use plugin config. The controller decides when to stop.',
      },
      grouping: {
        type: 'string',
        description: 'Finding merge mode, "evidence+claim" or "evidence". Omit to use plugin config.',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        const row = value as unknown as { report: string }
        return [{ type: 'text', text: row.report }]
      },
      presentationMeta(_args, value) {
        return value as JsonValue
      },
    },
    // The per-seat cap applies to each round, plus time for the user to answer the dialog.
    timeoutMs: timeoutMs * MAX_DEBATE_ROUNDS + 3_600_000,
    async execute(args, exec) {
      assertNoModelOverride(exec.arguments)
      const maxRounds = assertMaxRounds(args.maxRounds, defaultMaxRounds)
      const grouping = assertGrouping(args.grouping, defaultGrouping)
      const agent = exec.agent
      if (agent === undefined) throw new Error('review_debate requires an owning agent session')
      const preset = agent.session.header.agentPreset
      if (preset !== REVIEW_PRESET) {
        throw new Error(`review_debate is only available on the ${REVIEW_PRESET} preset, got ${JSON.stringify(preset)}`)
      }
      const cwd = agent.session.header.cwd
      if (cwd === undefined || cwd.length === 0) {
        throw new Error('review_debate requires the session cwd')
      }
      const settings = ctx.get('reviewSettings')
      if (settings === undefined) {
        throw new Error(`reviewer settings are unavailable: the ${JSON.stringify(REVIEW_SETTINGS_ENTRY)} row is not mounted`)
      }
      const llm = ctx.llm
      if (llm === undefined) {
        throw new Error('review_debate requires ctx.llm to call reviewer models')
      }
      const fs = ctx.fs
      if (fs === undefined) throw new Error('review_debate requires ctx.fs to read the material')
      const questions = ctx.get('userQuestions')
      if (questions === undefined) {
        throw new Error('review_debate cannot ask the user to confirm: no user-questions service is mounted')
      }
      const section = settings.current()
      const selected = selectReviewers(
        requireConfiguredReviewers(reviewersFromSection(section)),
        args.roles,
      )
      await resolveReviewerModels(selected, {
        listModels: provider => llm.listModels(provider),
        listEfforts: async (provider, model) => {
          const info = await llm.resolveModelInfo(provider, model)
          return info.reasoning?.efforts.map(effort => effort.id) ?? []
        },
      })
      const policy = ctx.get('sandboxPolicy')
      const standing = policy?.resolve({ session: agent.session })
      const sandboxMode: SandboxMode = standing?.mode ?? fs.sandboxMode ?? 'read-only'
      const material = await resolveMaterial({
        cwd,
        entries: materialEntries(args.material),
        signal: exec.signal,
        fs,
        sandboxMode,
        observe: (target, observation) => { ctx.emit('fs/observed', target, observation, exec) },
      }, { maxBytes: maxBaselineBytes, maxLines: maxBaselineLines })
      const scope: ReviewScopeText = {
        request: typeof args.focus === 'string' ? args.focus.trim() : '',
        ...guidanceFor(cwd, settings.reviewGuidance(), perspectiveFromSection(section)),
      }
      const language = settings.outputLanguages().review
      const bytes = material.manifest.reduce((sum, item) => sum + (item.bytes ?? 0), 0)
      const confirmation = renderConfirmation({
        manifest: material.manifest, scope, reviewers: selected.length, bytes, maxBytes: maxBaselineBytes, language,
      })
      const [start, change] = confirmation.options
      // The dialog shows what runs: this call asks, and only this call runs it.
      const answer = await questions.ask({
        questions: [{
          id: 'review-confirm',
          header: language.startsWith('zh') ? '确认评审' : 'Confirm review',
          question: confirmation.question,
          detail: confirmation.detail,
          options: confirmation.options.map(label => ({ label })),
        }],
        agent,
        signal: exec.signal,
      })
      const reply = answer.answers.find(item => item.id === 'review-confirm')
      const chosen = reply?.selected[0]
      const words = reply?.custom?.trim() ?? ''
      if (chosen !== start) {
        const wantsChange = chosen === change || words.length > 0
        return {
          outcome: wantsChange ? 'change-requested' : 'cancelled',
          userWords: words,
          report: wantsChange
            ? `The user did not start the review and asked for a change${words.length > 0 ? `: "${words}"` : '.'} `
              + 'Nothing was sent to any reviewer model. Adjust the material or focus from what they said and call review_debate again; ask them only if it is still unclear.'
            : 'The user cancelled the review. Nothing was sent to any reviewer model.',
        } as unknown as JsonValue
      }
      // The grouping call runs on the review window's own model, with no
      // conversation, no tools, and no seat or model named (grouping.ts).
      const route = agent.session.requestHeader()?.config
      const groupIssues = route === undefined ? undefined : async (system: string, user: string) => {
        const reply = await completeSeat(llm, {
          seatId: 'grouping',
          provider: route.provider,
          model: route.model,
          ...route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {},
          system,
          user,
          maxTokens,
          signal: AbortSignal.any([exec.signal, AbortSignal.timeout(timeoutMs)]),
          idleTimeoutMs,
        })
        return reply.ok ? { ok: true as const, text: reply.text } : { ok: false as const, error: reply.error }
      }
      const report = await runDebate({
        debateId: `debate-${randomUUID()}`,
        material,
        seats: toSeats(selected),
        maxRounds,
        maxParallel,
        maxTokens,
        timeoutMs,
        idleTimeoutMs,
        grouping,
        scope,
        outputLanguage: language,
        signal: exec.signal,
        complete: request => completeSeat(llm, request),
        ...groupIssues !== undefined && route !== undefined
          ? { groupIssues, groupingRoute: { provider: route.provider, model: route.model } }
          : {},
        // Log-only progress for the review panel: no surface operation, never model history.
        onProgress: (progress) => {
          agent.session.append('personal-review/progress', { callId: exec.callId, ...progress })
        },
      })
      return report as unknown as JsonValue
    },
  }))
}
