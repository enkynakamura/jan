/**
 * Verifies one reply of the assistant against the sources of its
 * conversation: the results of the tool calls and the attached files.
 *
 * A model, asked in a request of its own, lists the statements of the answer
 * that the sources contradict or do not support. The code then checks every
 * finding against the conversation, and marks in a copy of the reply the
 * statements whose finding held. Everything that happened is in the record
 * that comes back, the cases in which there is nothing to show included: the
 * caller keeps it with the reply.
 */
import type { ThreadContent, ThreadMessage } from '@janhq/core'
import type { SideRequestResult } from '@/lib/sideRequest'
import {
  readFindings,
  validFindings,
  type FindingEntry,
} from '@/lib/verifyFindings'
import { markFindings, withoutMarks } from '@/lib/verifyMarks'
import { buildPacket, verifyRequest } from '@/lib/verifyTurn'

/**
 * The output cap of the verifier. The engine closes the reasoning at about
 * three quarters of the cap, so the cap sets how long the verifier can think:
 * 8192 leaves 6144 tokens for reasoning. A verifier going through a reply of
 * five paragraphs against the sources of a conversation was closed before
 * the end with 8192, and with 32768 as well: there it took more than three
 * times as long, and both its findings were on statements the sources
 * support (one run). A larger cap did not buy a complete check, so the cap
 * is the smaller one, and a reasoning the engine closed is reported
 * (`reasoningCut`).
 */
export const VERIFY_MAX_OUTPUT_TOKENS = 8192

/**
 * What the Strata engines write at the end of a reasoning they close because
 * it has used its share of the output cap. An engine that closes it without
 * saying so is not recognised.
 */
export const REASONING_CLOSED =
  'I have thought about this long enough; time to give my answer.'

export type VerificationOutcome =
  /** At least one finding passed the checks. */
  | 'findings'
  /** The verifier answered that every statement is supported. */
  | 'no-findings'
  /** The verifier listed findings and none passed the checks. */
  | 'nothing-valid'
  /** The output held neither a finding nor `NO FINDINGS`. */
  | 'unreadable'
  /** The conversation has no source to check the answer against: not asked. */
  | 'no-sources'
  /** The verifier called a tool instead of answering. */
  | 'tool-call'
  /** The request failed. */
  | 'error'
  /** The user stopped it. */
  | 'stopped'

/** What one verification did. Plain data: it is saved with the reply. */
export type VerificationRecord = {
  /** When it started, in milliseconds since the epoch. */
  at: number
  outcome: VerificationOutcome
  seconds: number
  maxOutputTokens: number
  /** The cap cut the output: findings may be missing. */
  truncated: boolean
  /**
   * The engine closed the reasoning before the verifier was done with it:
   * the verifier may not have gone through the whole answer, whatever it
   * then wrote. Absent when it was not, and in the records made before.
   */
  reasoningCut?: true
  /** The model selected for the thread, which the request named. */
  model?: { provider: string; id: string }
  /** The model the engine says it answered with. */
  servedModel?: string
  finishReason?: string
  inputTokens?: number
  outputTokens?: number
  /** The tools the verifier called. None was run. */
  toolCalls: string[]
  /** What it gave each of them, as JSON text. Not in the records made before. */
  toolInputs?: string[]
  /** What the verifier wrote, and what it reasoned before. */
  output: string
  reasoning: string
  /**
   * Every piece of the output, with the reason it was discarded. A finding
   * that passed the checks also has in how many places its quote was found
   * in the text parts: zero means it left no mark.
   */
  entries: Array<FindingEntry & { occurrences?: number }>
  /** How many marks were written. */
  marks: number
  error?: string
}

/** Sends the request to the verifier model: `CustomChatTransport.sideRequest`. */
export type AskVerifier = (
  prompt: string,
  options: {
    maxOutputTokens: number
    abortSignal?: AbortSignal
    onProgress?: (characters: number) => void
  }
) => Promise<SideRequestResult & { model: { provider: string; id: string } }>

export type Verification = {
  record: VerificationRecord
  /** The content of the reply with the marks, when any mark was written. */
  markedContent?: ThreadContent[]
}

/**
 * Verifies the reply that ends `path`, the conversation in order up to it.
 *
 * The verifier is sent the reply without the marks of earlier verifications,
 * so that it always judges what the model wrote. Marks are added to the
 * reply as it is now.
 */
export async function verifyReply(
  path: ThreadMessage[],
  ask: AskVerifier,
  options: {
    abortSignal?: AbortSignal
    onProgress?: (characters: number) => void
    now?: () => number
  } = {}
): Promise<Verification> {
  const now = options.now ?? Date.now
  const at = now()
  const record = (
    outcome: VerificationOutcome,
    more: Partial<VerificationRecord> = {}
  ): VerificationRecord => ({
    at,
    outcome,
    seconds: (now() - at) / 1000,
    maxOutputTokens: VERIFY_MAX_OUTPUT_TOKENS,
    truncated: false,
    toolCalls: [],
    output: '',
    reasoning: '',
    entries: [],
    marks: 0,
    ...more,
  })

  const reply = path[path.length - 1]
  const packet = buildPacket([
    ...path.slice(0, -1),
    { ...reply, content: withoutMarks(reply.content) },
  ])
  if (packet.sourceCount === 0) return { record: record('no-sources') }

  let answer: Awaited<ReturnType<AskVerifier>>
  try {
    answer = await ask(verifyRequest(packet.text, packet.conversation), {
      maxOutputTokens: VERIFY_MAX_OUTPUT_TOKENS,
      abortSignal: options.abortSignal,
      onProgress: options.onProgress,
    })
  } catch (error) {
    const stopped =
      options.abortSignal?.aborted === true ||
      (error instanceof Error && error.name === 'AbortError')
    return {
      record: record(stopped ? 'stopped' : 'error', {
        ...(stopped
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      }),
    }
  }

  const asked: Partial<VerificationRecord> = {
    model: answer.model,
    servedModel: answer.servedModel,
    finishReason: answer.finishReason,
    inputTokens: answer.inputTokens,
    outputTokens: answer.outputTokens,
    // Either sign: an engine can report `stop` for an answer it cut.
    truncated:
      answer.finishReason === 'length' ||
      (answer.outputTokens ?? 0) >= VERIFY_MAX_OUTPUT_TOKENS,
    toolCalls: answer.toolCalls,
    toolInputs: answer.toolInputs,
    output: answer.text,
    reasoning: answer.reasoning,
    ...(answer.reasoning.trimEnd().endsWith(REASONING_CLOSED)
      ? { reasoningCut: true as const }
      : {}),
  }
  if (answer.toolCalls.length > 0) return { record: record('tool-call', asked) }

  const reading = readFindings(answer.text, packet.answer, packet.sources)
  if (reading.noFindings) return { record: record('no-findings', asked) }

  const findings = validFindings(reading)
  const marked = markFindings(reply.content, findings)
  let valid = 0
  const entries = reading.entries.map((entry) =>
    entry.valid ? { ...entry, occurrences: marked.occurrences[valid++] } : entry
  )
  const outcome =
    findings.length > 0
      ? 'findings'
      : reading.entries.some((entry) => entry.finding)
        ? 'nothing-valid'
        : 'unreadable'
  return {
    record: record(outcome, { ...asked, entries, marks: marked.inserted }),
    ...(marked.inserted > 0 ? { markedContent: marked.content } : {}),
  }
}
