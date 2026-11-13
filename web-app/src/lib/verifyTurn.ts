/**
 * What a verifier model is sent to check a reply: the conversation written
 * out as text, and the request that tells the verifier what to do with it.
 *
 * The verifier checks the answer against the sources the assistant had: the
 * results of its tool calls and the files the user attached, in the whole
 * conversation and not only in the last turn, since an answer to a follow-up
 * question rests on what earlier turns opened. Reasoning is left out: it is
 * what the model recalled, not something the answer can be checked against.
 * So are the answers to earlier requests: they are the assistant's own words,
 * not a source.
 */
import type { ThreadContent, ThreadMessage } from '@janhq/core'

/** A reply, as the verifier reads it and as its findings are checked. */
export type TurnPacket = {
  /** The requests, the sources and the answer, as the verifier is sent them. */
  text: string
  /** The text parts of the reply, joined by a newline. */
  answer: string
  /** The tool results and the attached files, joined by a newline. */
  sources: string
  /** How many tool calls have a result, plus how many files are attached. */
  sourceCount: number
  /**
   * Whether the text holds more than the last request and the reply to it:
   * earlier turns, or attached files. It decides the wording of the request.
   */
  conversation: boolean
}

const REQUEST_BEFORE_TURN = [
  "The text between the markers is one turn of work by an assistant: the user's request, the assistant's tool calls with their results, and its final answer. You are checking the answer against the tool results. You did not write it.",
  '',
  'Go through the answer one sentence at a time. For each statement of fact about the sources, look in the tool results for the passage that supports it. Report only statements that fall in one of two cases:',
  '- "contradicted": a passage in the tool results says something different;',
  '- "unsupported": no passage in the tool results says it.',
  'A statement that correctly restates or translates a passage is supported, even when the wording differs: do not report it. Do not report format, style, labels, links or missing quotation marks. Do not correct the answer. Do not use what you remember about the topic: only the tool results count. Do not call any tool: your whole reply is the findings, or NO FINDINGS.',
  '',
  'Output at most 10 findings, the most serious first, one JSON object per line, with these fields:',
  'n: a counter starting at 1',
  'verdict: "contradicted" or "unsupported"',
  'quote: the statement, copied character for character from the answer (the words of the statement, not a link or a marker)',
  'source: for "contradicted", the passage of the tool results that contradicts it, copied character for character; for "unsupported", null',
  'why: one sentence',
  '',
  'Escape every string so that each line is valid JSON. A finding whose quote or source is not found in the turn is discarded. If every statement is supported, output exactly: NO FINDINGS',
  '',
  '<<<TURN',
].join('\n')
const REQUEST_AFTER_TURN = 'TURN>>>\n'

const REQUEST_BEFORE_CONVERSATION = [
  "The text between the markers is a conversation between a user and an assistant, reduced to what the assistant's last answer can be checked against: for each turn, the user's request, the files the user attached and the assistant's tool calls with their results; then, at the end, the assistant's answer to the last request. The answers to the earlier requests are left out. The attached files and the tool results of the whole conversation are the sources. You are checking the answer against the sources. You did not write it.",
  '',
  'Go through the answer one sentence at a time. For each statement of fact about the sources, look in the sources for the passage that supports it. Report only statements that fall in one of two cases:',
  '- "contradicted": a passage in the sources says something different;',
  '- "unsupported": no passage in the sources says it.',
  'A statement that correctly restates or translates a passage is supported, even when the wording differs: do not report it. Do not report format, style, labels, links or missing quotation marks. Do not correct the answer. Do not use what you remember about the topic: only the sources count. Do not call any tool: your whole reply is the findings, or NO FINDINGS.',
  '',
  'Output at most 10 findings, the most serious first, one JSON object per line, with these fields:',
  'n: a counter starting at 1',
  'verdict: "contradicted" or "unsupported"',
  'quote: the statement, copied character for character from the answer (the words of the statement, not a link or a marker)',
  'source: for "contradicted", the passage of the sources that contradicts it, copied character for character; for "unsupported", null',
  'why: one sentence',
  '',
  'Escape every string so that each line is valid JSON. A finding whose quote or source is not found in the conversation is discarded. If every statement is supported, output exactly: NO FINDINGS',
  '',
  '<<<CONVERSATION',
].join('\n')
const REQUEST_AFTER_CONVERSATION = 'CONVERSATION>>>\n'

/**
 * The message sent to the verifier. There are two wordings: one for a single
 * turn (the last request and the reply to it, nothing attached), one for a
 * conversation. The first was tried on real turns before it was written here.
 * Findings depend on the wording, so a change to either has to be tried again.
 *
 * The tools of the thread are offered with the request, so that it starts
 * with the prompt the engine has already read, and the system message of a
 * thread may ask for them to be used: both wordings say not to. The sentence
 * was added after a verifier called one instead of answering.
 */
export function verifyRequest(text: string, conversation = false): string {
  return conversation
    ? `${REQUEST_BEFORE_CONVERSATION}\n${text}\n${REQUEST_AFTER_CONVERSATION}`
    : `${REQUEST_BEFORE_TURN}\n${text}\n${REQUEST_AFTER_TURN}`
}

const textOf = (part: ThreadContent) => part.text?.value ?? ''

/**
 * A tool result as text. A string is kept as it is. In a list, as MCP servers
 * return, text items are joined and an item that carries data (an image) is
 * named instead of shown: its base64 is of no use to the verifier and can be
 * larger than the context. Anything else is written as JSON.
 */
export function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return JSON.stringify(output)
  return output
    .map((item: { type?: unknown; text?: unknown; data?: unknown } | null) =>
      typeof item?.text === 'string'
        ? item.text
        : typeof item?.data === 'string'
          ? `(${typeof item.type === 'string' ? item.type : 'data'}, not shown)`
          : JSON.stringify(item)
    )
    .join('')
}

/** The error a tool call ended with, as the model was sent it. */
function toolErrorOf(reply: ThreadMessage, call: ThreadContent) {
  const errors = reply.metadata?.toolErrors as
    Record<string, string> | undefined
  const ownError = (call as { error_text?: unknown }).error_text
  return (
    errors?.[call.tool_call_id ?? ''] ??
    (typeof ownError === 'string' ? ownError : undefined)
  )
}

/** The files attached to a user message whose text the model was sent. */
function attachedFiles(message: ThreadMessage) {
  const files = message.metadata?.inline_file_contents as
    Array<{ name?: string; content?: string } | null> | undefined
  return Array.isArray(files)
    ? files.flatMap((file) =>
        file?.content
          ? [{ name: file.name || 'attachment', content: file.content }]
          : []
      )
    : []
}

/**
 * Writes out for the verifier the conversation that ends with a reply.
 * `path` is the conversation in order, as it is shown and sent (the active
 * path), up to the reply to verify, which is its last message.
 *
 * A conversation made of one request with nothing attached and the reply to
 * it is written as that turn alone, the form the first wording of the request
 * was tried on. Any other is written turn by turn.
 */
export function buildPacket(path: ThreadMessage[]): TurnPacket {
  const reply = path[path.length - 1]
  const before = path.slice(0, -1)
  const conversation =
    before.length > 1 ||
    before.some((message) => attachedFiles(message).length > 0)
  const lines: string[] = []
  const answer: string[] = []
  const sources: string[] = []
  let turns = 0

  const writeRequest = (request: ThreadMessage) => {
    if (conversation) lines.push(...(turns ? [''] : []), `[TURN ${++turns}]`)
    lines.push('[USER REQUEST]')
    for (const part of request.content) {
      lines.push(
        part.type === 'text'
          ? textOf(part)
          : `(${part.type} attachment, not shown)`
      )
    }
    for (const file of attachedFiles(request)) {
      lines.push(`[ATTACHED FILE] ${file.name}`, file.content)
      sources.push(file.content)
    }
  }
  const writeCall = (message: ThreadMessage, part: ThreadContent) => {
    lines.push(
      '',
      `[TOOL CALL] ${part.tool_name}`,
      JSON.stringify(part.input ?? null)
    )
    const error = toolErrorOf(message, part)
    if (part.output != null) {
      const result = toolOutputText(part.output)
      lines.push('[TOOL RESULT]', result)
      sources.push(result)
    } else if (error) {
      lines.push('[TOOL ERROR]', error)
    } else {
      lines.push('[TOOL RESULT]', '(none)')
    }
  }

  for (const message of before) {
    if (message.role === 'user') {
      writeRequest(message)
    } else {
      // An earlier turn: what its tools returned, not what it answered.
      for (const part of message.content) {
        if (part.type === 'tool_call') writeCall(message, part)
      }
    }
  }
  for (const part of reply.content) {
    if (part.type === 'reasoning') continue
    if (part.type === 'text') {
      lines.push('', '[ANSWER]', textOf(part))
      answer.push(textOf(part))
    } else if (part.type === 'tool_call') {
      writeCall(reply, part)
    } else {
      lines.push('', `(${part.type} part, not shown)`)
    }
  }
  return {
    text: lines.join('\n'),
    answer: answer.join('\n'),
    sources: sources.join('\n'),
    sourceCount: sources.length,
    conversation,
  }
}

/**
 * The turn that ends a conversation: its last message, when that is a reply of
 * the assistant, and the user message it answers. `path` is the conversation
 * in order, as it is shown and sent (the active path).
 */
export function lastTurn(
  path: ThreadMessage[]
): { request: ThreadMessage; reply: ThreadMessage } | undefined {
  const reply = path[path.length - 1]
  if (reply?.role !== 'assistant') return undefined
  for (let i = path.length - 2; i >= 0; i--) {
    if (path[i].role === 'user') {
      return { request: path[i], reply }
    }
  }
  return undefined
}
