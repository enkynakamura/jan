/**
 * One request to a model outside any conversation: a prompt goes in, the whole
 * answer comes back. It is streamed, so that a long answer can be followed and
 * stopped, but nothing of it is shown as a chat message.
 *
 * Tools can be offered, as they are in a turn, without being run: a request
 * that carries the same system message and the same tools as the turns of a
 * thread starts with the same prompt, which the engine has already read. A
 * call the model makes instead of answering is reported, not executed.
 */
import { streamText, type LanguageModel, type Tool } from 'ai'

export type SideRequest = {
  model: LanguageModel
  system: string | undefined
  /** Offered with `toolChoice: 'auto'`, as in a turn. None is run. */
  tools: Record<string, Tool> | undefined
  /** Sent as the only message, from the user. */
  prompt: string
  maxOutputTokens: number
  maxRetries: number
  abortSignal?: AbortSignal
  providerOptions?: Parameters<typeof streamText>[0]['providerOptions']
  /** Called as the answer arrives, with the characters received so far. */
  onProgress?: (characters: number) => void
}

export type SideRequestResult = {
  text: string
  reasoning: string
  /** `stop`, `length` when the output cap cut the answer, `tool-calls`... */
  finishReason: string
  inputTokens: number | undefined
  outputTokens: number | undefined
  /** The tools the model called instead of answering. */
  toolCalls: string[]
  /** What it gave each of them, in the same order, as JSON text. */
  toolInputs: string[]
  /**
   * The model the answer says it came from. A local engine answers with the
   * model it has loaded, whatever name the request asked for.
   */
  servedModel: string
}

/**
 * Sends the request and waits for the whole answer. Rejects with the error of
 * the provider when the request fails, before or during the answer, and with
 * an `AbortError` when `abortSignal` fires.
 */
export async function runSideRequest(
  request: SideRequest
): Promise<SideRequestResult> {
  const result = streamText({
    model: request.model,
    system: request.system,
    messages: [{ role: 'user', content: request.prompt }],
    tools: request.tools,
    toolChoice: request.tools ? 'auto' : undefined,
    maxOutputTokens: request.maxOutputTokens,
    maxRetries: request.maxRetries,
    abortSignal: request.abortSignal,
    ...(request.providerOptions
      ? { providerOptions: request.providerOptions }
      : {}),
    // A failure is not thrown by the stream: it comes as a part of it, read
    // below, and is thrown from here once. This keeps it out of the console.
    onError: () => {},
  })

  let failure: { error: unknown } | undefined
  let characters = 0
  for await (const part of result.fullStream) {
    if (part.type === 'error') {
      failure = { error: part.error }
    } else if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
      characters += part.text.length
      request.onProgress?.(characters)
    }
  }
  if (failure) throw failure.error

  // After a stop these reject with the AbortError.
  const [text, reasoning, finishReason, usage, toolCalls, response] =
    await Promise.all([
      result.text,
      result.reasoningText,
      result.finishReason,
      result.totalUsage,
      result.toolCalls,
      result.response,
    ])
  return {
    text,
    reasoning: reasoning ?? '',
    finishReason,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    toolCalls: toolCalls.map((call) => call.toolName),
    toolInputs: toolCalls.map((call) =>
      typeof call.input === 'string' ? call.input : JSON.stringify(call.input)
    ),
    servedModel: response.modelId,
  }
}
