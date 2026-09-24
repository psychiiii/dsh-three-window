/**
 * Direct `ctx.llm.stream()` seat call and stream-contract checks.
 * @module @psychiiii/dsh-three-window-review/complete
 */

import {
  BlockAssembler,
  createUserMessage,
  ReasoningEffortId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

/** The seat prompt `review_debate` sends in a direct model call; no session logs it. */
export interface ReviewSeatMessageSource {
  readonly kind: 'dsh-three-window-review'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Seat prompts of the anonymous multi-model review. */
    'dsh-three-window-review': ReviewSeatMessageSource
  }
}

/** One seat completion request. Provider/model stay off the prompt text. */
export interface SeatCompleteRequest {
  readonly seatId: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly system: string
  readonly user: string
  /**
   * Per-call output cap. `0` omits `GenerateOptions.maxTokens` so the adapter
   * materializes `defaultMaxTokens`.
   */
  readonly maxTokens: number
  readonly signal: AbortSignal
}

/** Assembled seat text, or a neutral failure reason. */
export type SeatTextResult =
  | { readonly ok: true; readonly text: string; readonly finish: string }
  | { readonly ok: false; readonly error: string; readonly finish?: string }

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Build the one-shot `GenerateOptions` for a seat. `maxTokens` is omitted when
 * the request value is `0`.
 * @param request - route, prompts, cap, and abort signal.
 */
export function buildSeatGenerateOptions(request: SeatCompleteRequest): GenerateOptions {
  return deepFreeze({
    provider: request.provider,
    model: request.model,
    ...request.reasoningEffort !== undefined
      ? { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }
      : {},
    system: request.system,
    messages: [createUserMessage({
      content: [{ type: 'text', text: request.user }],
      source: { kind: 'dsh-three-window-review' },
    })],
    ...request.maxTokens > 0 ? { maxTokens: request.maxTokens } : {},
    signal: request.signal,
  })
}

/**
 * Consume zero or more reasoning blocks, one JSON text block, and one terminal stop.
 * Abort, a non-stop finish, output after finish, a non-text last block, or a
 * non-reasoning non-text block fails the seat. Partial text is never returned.
 * @param stream - `ctx.llm.stream()` iterable.
 * @param signal - combined tool and per-call timeout signal.
 */
export async function readSeatText(
  stream: AsyncIterable<StreamChunk>,
  signal: AbortSignal,
): Promise<SeatTextResult> {
  if (isAborted(signal)) return { ok: false, error: 'seat call aborted' }
  const assembler = new BlockAssembler()
  let finished = false
  let finish = 'stop'
  try {
    for await (const chunk of stream) {
      if (isAborted(signal)) return { ok: false, error: 'seat call aborted' }
      if (finished) return { ok: false, error: 'seat emitted data after its terminal finish', finish }
      assembler.push(chunk)
      if (chunk.type === 'finish') {
        finished = true
        finish = chunk.reason.kind
        if (chunk.reason.kind !== 'stop') {
          const failure = chunk.reason.kind === 'error' ? chunk.reason.failure : undefined
          const detail = failure === undefined
            ? ''
            : ` (${failure.code}: ${failure.message})`
          return { ok: false, error: `seat ended with ${chunk.reason.kind}${detail}`, finish }
        }
      }
    }
  } catch {
    if (isAborted(signal)) return { ok: false, error: 'seat call aborted' }
    return { ok: false, error: 'seat stream failed' }
  }
  if (!finished) return { ok: false, error: 'seat emitted no terminal finish' }
  const blocks = assembler.blocks()
  const final = blocks.at(-1)
  if (final?.type !== 'text' || blocks.slice(0, -1).some(block => block.type !== 'reasoning')) {
    return {
      ok: false,
      error: 'seat must emit zero or more reasoning blocks followed by exactly one text block',
      finish,
    }
  }
  return { ok: true, text: final.text, finish }
}

/** Minimal LLM face used by {@link completeSeat}. */
export interface SeatLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * One-shot seat call: `GenerateOptions` has no session and no tools. `maxTokens`
 * is included only when the request cap is a positive integer.
 * @param llm - host `ctx.llm`.
 * @param request - route, prompts, cap, and abort signal.
 */
export async function completeSeat(
  llm: SeatLlm,
  request: SeatCompleteRequest,
): Promise<SeatTextResult> {
  return readSeatText(llm.stream(buildSeatGenerateOptions(request)), request.signal)
}
