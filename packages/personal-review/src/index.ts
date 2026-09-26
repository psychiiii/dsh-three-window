/**
 * Host plugin: `review_debate` plus the `personalReview` session projection.
 * @module @psychiiii/dsh-three-window-review
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveBaseline } from './baseline.ts'
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
import type {} from './settings.ts'
import { MAX_DEBATE_ROUNDS, type DebateReport, type GroupingMode } from './types.ts'

export type * from './types.ts'
export { resolveBaseline, CONSTRUCT_REPORT, assertBaselineSize, sessionResolveOptions } from './baseline.ts'
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
export { renderDebateReport } from './report.ts'
export {
  DEBATE_SYSTEM_PROMPT, DEFAULT_PERSPECTIVE, buildInitialUserPrompt, buildChallengeUserPrompt,
  resolvePerspective,
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

export const name = 'personal-review'
export const inject = ['tools', 'sessionProjections', 'llm', 'fs']

/** Plugin config: seat concurrency, per-call timeout, token cap, and baseline caps. */
export interface Config {
  /** Concurrent seat-call cap inside one round. */
  maxParallel: number
  /** Per-seat timeout in ms, combined with the tool abort signal. */
  timeoutMs: number
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
  timeoutMs: z.number().default(180_000),
  maxBaselineBytes: z.number().default(262_144),
  maxBaselineLines: z.number().default(8_000),
  maxRounds: z.number().default(MAX_DEBATE_ROUNDS),
  maxTokens: z.number().default(0),
  grouping: z.union([z.const('evidence+claim' as const), z.const('evidence' as const)]).default('evidence'),
})

const findingSchema = zod.object({
  severity: zod.union([zod.literal('PASS'), zod.literal('NEEDS-WORK'), zod.literal('FAIL')]),
  evidence: zod.string(),
  seatCount: zod.number(),
  seats: zod.array(zod.string()),
  claims: zod.array(zod.object({
    claim: zod.string(),
    seats: zod.array(zod.string()),
  })),
})

const challengeSchema = zod.object({
  target: zod.string(),
  verdict: zod.union([
    zod.literal('upheld'),
    zod.literal('weakened'),
    zod.literal('contradicted'),
    zod.literal('needs-authority'),
  ]),
  evidence: zod.string(),
})

const reportSchema = zod.union([
  zod.object({
    debateId: zod.string(),
    baselineId: zod.string(),
    grouping: zod.union([zod.literal('evidence+claim'), zod.literal('evidence')]),
    terminal: zod.union([
      zod.literal('incomplete_review'),
      zod.literal('blocked_by_missing_decision'),
      zod.literal('changes_proposed'),
      zod.literal('clear_within_scope'),
    ]),
    converged: zod.boolean(),
    roundsUsed: zod.number(),
    reviewKind: zod.union([zod.literal('single-model'), zod.literal('multi-model')]),
    uniqueModelCount: zod.number(),
    findings: zod.array(findingSchema),
    dissent: zod.array(findingSchema),
    rounds: zod.array(zod.object({
      round: zod.number(),
      changed: zod.boolean(),
      seats: zod.array(zod.object({
        seatId: zod.string(),
        ok: zod.boolean(),
        error: zod.string().optional(),
        verdict: zod.union([zod.literal('PASS'), zod.literal('NEEDS-WORK'), zod.literal('FAIL')]).optional(),
        findingCount: zod.number().optional(),
        challenges: zod.array(challengeSchema).optional(),
        finish: zod.string().optional(),
        elapsedMs: zod.number().optional(),
      })),
      elapsedMs: zod.number(),
    })),
    report: zod.string(),
    seats: zod.array(zod.object({
      seatId: zod.string(),
      provider: zod.string(),
      model: zod.string(),
      role: zod.string(),
    })),
    prompts: zod.array(zod.object({
      round: zod.number(),
      seatId: zod.string(),
      system: zod.string(),
      user: zod.string(),
    })),
  }),
  zod.null(),
]) as ZodType<DebateReport | null>

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
  const maxBaselineBytes = config.maxBaselineBytes
  const maxBaselineLines = config.maxBaselineLines
  const defaultMaxRounds = config.maxRounds
  const maxTokens = config.maxTokens
  const defaultGrouping = config.grouping

  ctx.sessionProjections.register<'personalReview', DebateReport | null>({
    key: 'personalReview',
    stateVersion: 3,
    stateSchema: reportSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'tool/result') {
        const meta = event.data.meta
        if (meta === undefined || typeof meta !== 'object' || Array.isArray(meta)) return state
        const record = meta as { debateId?: unknown }
        if (typeof record.debateId !== 'string') return state
        const parsed = reportSchema.safeParse(meta)
        return parsed.success ? parsed.data : state
      }
      return state
    },
    wire: { viewSchema: reportSchema, view: state => state },
  })

  ctx.tools.register(defineTool({
    name: 'review_debate',
    description:
      'Run an anonymous multi-model review debate of one baseline (at most 3 rounds) '
      + 'and return a single report. Reviewer models come from the review-window '
      + 'Review models settings; the caller must not pass model, provider, or agentOptions. '
      + 'Passing maxTokens, temperature, callTimeoutMs, or other seat-call overrides is an error. '
      + 'Optional arguments: baseline (git ref or file path) and roles (subset of configured reviewer roles). '
      + 'Optional maxRounds is an integer 1–3; optional grouping is "evidence+claim" or "evidence". '
      + 'Out-of-range values error instead of truncating.',
    parameters: {
      baseline: {
        type: 'string',
        description: 'Git commit, file path, or omit to use construct-report then HEAD.',
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
        description: 'Finding merge mode: "evidence+claim" or "evidence". Omit to use plugin config.',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        const row = value as unknown as DebateReport
        return [{ type: 'text', text: row.report }]
      },
      presentationMeta(_args, value) {
        return value as JsonValue
      },
    },
    timeoutMs: timeoutMs * MAX_DEBATE_ROUNDS,
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
      const section = settings.current()
      const selected = selectReviewers(
        requireConfiguredReviewers(reviewersFromSection(section)),
        args.roles,
      )
      const llm = ctx.llm
      if (llm === undefined) {
        throw new Error('review_debate requires ctx.llm to call reviewer models')
      }
      await resolveReviewerModels(selected, {
        listModels: provider => llm.listModels(provider),
        listEfforts: async (provider, model) => {
          const info = await llm.resolveModelInfo(provider, model)
          return info.reasoning?.efforts.map(effort => effort.id) ?? []
        },
      })
      const fs = ctx.fs
      if (fs === undefined) throw new Error('review_debate requires ctx.fs to resolve file baselines')
      const policy = ctx.get('sandboxPolicy')
      const standing = policy?.resolve(exec.agent !== undefined ? { session: exec.agent.session } : {})
      const sandboxMode: SandboxMode = standing?.mode ?? fs.sandboxMode ?? 'read-only'
      const baseline = await resolveBaseline({
        cwd,
        ...typeof args.baseline === 'string' ? { explicit: args.baseline } : {},
        signal: exec.signal,
        fs,
        sandboxMode,
        observe: (target, observation) => { ctx.emit('fs/observed', target, observation, exec) },
      }, { maxBytes: maxBaselineBytes, maxLines: maxBaselineLines })
      const report = await runDebate({
        debateId: `debate-${randomUUID()}`,
        baseline,
        seats: toSeats(selected),
        maxRounds,
        maxParallel,
        maxTokens,
        timeoutMs,
        grouping,
        perspective: perspectiveFromSection(section),
        outputLanguage: settings.outputLanguages().review,
        signal: exec.signal,
        complete: request => completeSeat(llm, request),
      })
      return report as unknown as JsonValue
    },
  }))
}
