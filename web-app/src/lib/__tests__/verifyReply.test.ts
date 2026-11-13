import { describe, it, expect, vi } from 'vitest'
import {
  ChatCompletionRole,
  ContentType,
  MessageStatus,
  type ThreadContent,
  type ThreadMessage,
} from '@janhq/core'
import { CONTRADICTED_MARK, UNVERIFIED_MARK } from '../verifyMarks'
import {
  VERIFY_MAX_OUTPUT_TOKENS,
  verifyReply,
  type AskVerifier,
} from '../verifyReply'
import { verifyRequest } from '../verifyTurn'

// A made-up turn: nothing here comes from a real conversation.
const message = (
  role: ChatCompletionRole,
  content: ThreadContent[]
): ThreadMessage => ({
  id: role,
  object: 'thread.message',
  thread_id: 't1',
  role,
  content,
  status: MessageStatus.Ready,
  created_at: 1,
  completed_at: 1,
})
const text = (value: string): ThreadContent => ({
  type: ContentType.Text,
  text: { value, annotations: [] },
})
const fetched = (output: unknown) =>
  ({
    type: ContentType.ToolCall,
    tool_call_id: 'c1',
    tool_name: 'web_fetch',
    input: { url: 'https://example.org/alda' },
    output,
  }) as ThreadContent
const reasoning: ThreadContent = {
  type: ContentType.Reasoning,
  text: { value: 'I recall 1932.', annotations: [] },
}

const U = ` ${UNVERIFIED_MARK}`
const C = ` ${CONTRADICTED_MARK}`
const SOURCE = 'Alda bridge. Opened to traffic in 1934. Total length: 412 m.'
const ANSWER =
  'The Alda bridge opened in 1932. It is 412 metres long. Its engineer was Marta Lindqvist.'
const request = message(ChatCompletionRole.User, [
  text('Tell me about the Alda bridge.'),
])
const call = fetched(SOURCE)
const reply = message(ChatCompletionRole.Assistant, [
  reasoning,
  call,
  text(ANSWER),
])

const contradicted = {
  n: 1,
  verdict: 'contradicted',
  quote: 'The Alda bridge opened in 1932.',
  source: 'Opened to traffic in 1934.',
  why: 'The source gives 1934.',
}
const unsupported = {
  n: 2,
  verdict: 'unsupported',
  quote: 'Its engineer was Marta Lindqvist.',
  source: null,
  why: 'No passage names the engineer.',
}
const notInAnswer = {
  n: 3,
  verdict: 'unsupported',
  quote: 'It is 412 meters long.',
  source: null,
  why: 'Spelled differently in the answer.',
}
const lines = (...findings: object[]) =>
  findings.map((finding) => JSON.stringify(finding)).join('\n')

const model = { provider: 'strata', id: 'q8' }
/** A verifier that answers `text`, and the mock to see what it was asked. */
const answering = (
  text: string,
  more: Partial<Awaited<ReturnType<AskVerifier>>> = {}
) =>
  vi.fn<AskVerifier>(async () => ({
    text,
    reasoning: 'I compared each sentence.',
    finishReason: 'stop',
    inputTokens: 900,
    outputTokens: 300,
    toolCalls: [],
    servedModel: 'q8-served',
    model,
    ...more,
  }))
/** A clock that moves 2.5 seconds at every reading. */
const clock = () => {
  let time = 1000
  return () => (time += 2500) - 2500
}

describe('verifyReply: what the verifier is asked', () => {
  it('sends the turn without the reasoning, with the cap, the signal and the callback', async () => {
    const ask = answering('NO FINDINGS')
    const controller = new AbortController()
    const onProgress = vi.fn()
    await verifyReply([request, reply], ask, {
      abortSignal: controller.signal,
      onProgress,
    })

    expect(ask).toHaveBeenCalledTimes(1)
    const [prompt, options] = ask.mock.calls[0]
    expect(prompt).toBe(
      verifyRequest(
        [
          '[USER REQUEST]',
          'Tell me about the Alda bridge.',
          '',
          '[TOOL CALL] web_fetch',
          '{"url":"https://example.org/alda"}',
          '[TOOL RESULT]',
          SOURCE,
          '',
          '[ANSWER]',
          ANSWER,
        ].join('\n')
      )
    )
    expect(prompt).not.toContain('I recall 1932.')
    expect(options).toEqual({
      maxOutputTokens: VERIFY_MAX_OUTPUT_TOKENS,
      abortSignal: controller.signal,
      onProgress,
    })
    expect(VERIFY_MAX_OUTPUT_TOKENS).toBe(8192)
  })

  it('does not ask when the turn has no tool result', async () => {
    const ask = answering('NO FINDINGS')
    const fromMemory = message(ChatCompletionRole.Assistant, [text(ANSWER)])
    const result = await verifyReply([request, fromMemory], ask, {
      now: clock(),
    })

    expect(ask).not.toHaveBeenCalled()
    expect(result).toEqual({
      record: {
        at: 1000,
        outcome: 'no-sources',
        seconds: 2.5,
        maxOutputTokens: 8192,
        truncated: false,
        toolCalls: [],
        output: '',
        reasoning: '',
        entries: [],
        marks: 0,
      },
    })
  })
})

describe('verifyReply: findings', () => {
  it('marks the statements whose finding passed the checks, and records all of them', async () => {
    const output = lines(contradicted, unsupported, notInAnswer)
    const result = await verifyReply([request, reply], answering(output), {
      now: clock(),
    })

    expect(result.markedContent).toEqual([
      reasoning,
      call,
      text(
        `The Alda bridge opened in 1932.${C} It is 412 metres long. Its engineer was Marta Lindqvist.${U}`
      ),
    ])
    // Reasoning and tool call are the same parts, not copies.
    expect(result.markedContent?.[0]).toBe(reasoning)
    expect(result.markedContent?.[1]).toBe(call)
    expect(result.record).toEqual({
      at: 1000,
      outcome: 'findings',
      seconds: 2.5,
      maxOutputTokens: 8192,
      truncated: false,
      model,
      servedModel: 'q8-served',
      finishReason: 'stop',
      inputTokens: 900,
      outputTokens: 300,
      toolCalls: [],
      output,
      reasoning: 'I compared each sentence.',
      entries: [
        {
          raw: JSON.stringify(contradicted),
          finding: contradicted,
          valid: true,
          rejections: [],
          occurrences: 1,
        },
        {
          raw: JSON.stringify(unsupported),
          finding: unsupported,
          valid: true,
          rejections: [],
          occurrences: 1,
        },
        {
          raw: JSON.stringify(notInAnswer),
          finding: notInAnswer,
          valid: false,
          rejections: ['quote-not-found'],
        },
      ],
      marks: 2,
    })
    // The reply that was verified is not changed.
    expect(reply.content[2]).toEqual(text(ANSWER))
  })

  it('records for each finding in how many places it was marked', async () => {
    const twice = message(ChatCompletionRole.Assistant, [
      call,
      text('It is long. It opened in 1932. Truly, it is long.'),
    ])
    const long = { ...unsupported, quote: 't is long' }
    const opened = { ...contradicted, quote: 'It opened in 1932.' }
    const result = await verifyReply(
      [request, twice],
      answering(lines(long, notInAnswer, opened))
    )
    expect(result.markedContent?.[1]).toEqual(
      text(`It is long${U}. It opened in 1932.${C} Truly, it is long${U}.`)
    )
    expect(result.record.entries.map((entry) => entry.occurrences)).toEqual([
      2,
      undefined,
      1,
    ])
    expect(result.record.marks).toBe(3)
  })

  it('returns a record that is plain data', async () => {
    const { record } = await verifyReply(
      [request, reply],
      answering(lines(contradicted, notInAnswer) + '\nThat is all.')
    )
    expect(JSON.parse(JSON.stringify(record))).toEqual(record)
  })

  it('records a finding that leaves no mark because its quote runs across two text parts', async () => {
    const split = message(ChatCompletionRole.Assistant, [
      text('The Alda bridge opened in 1932.'),
      call,
      text('It is 412 metres long.'),
    ])
    const across = {
      ...unsupported,
      quote: 'opened in 1932.\nIt is 412 metres',
    }
    const result = await verifyReply([request, split], answering(lines(across)))
    expect(result.markedContent).toBeUndefined()
    expect(result.record.outcome).toBe('findings')
    expect(result.record.entries[0]).toMatchObject({
      valid: true,
      occurrences: 0,
    })
    expect(result.record.marks).toBe(0)
  })

  it('reports that every statement is supported', async () => {
    const result = await verifyReply([request, reply], answering('NO FINDINGS'))
    expect(result.markedContent).toBeUndefined()
    expect(result.record).toMatchObject({
      outcome: 'no-findings',
      output: 'NO FINDINGS',
      entries: [],
      marks: 0,
    })
  })
})

describe('verifyReply: a reply that was already marked', () => {
  const markedReply = message(ChatCompletionRole.Assistant, [
    reasoning,
    call,
    text(
      `The Alda bridge opened in 1932.${C} It is 412 metres long. Its engineer was Marta Lindqvist.`
    ),
  ])

  it('asks about the reply as the model wrote it, without the marks', async () => {
    const ask = answering('NO FINDINGS')
    await verifyReply([request, markedReply], ask)
    const [prompt] = ask.mock.calls[0]
    expect(prompt).toContain(`[ANSWER]\n${ANSWER}\nTURN>>>`)
    expect(prompt).not.toContain(CONTRADICTED_MARK)
  })

  it('adds the marks that are new and keeps the ones that were there', async () => {
    const result = await verifyReply(
      [request, markedReply],
      answering(lines(contradicted, unsupported))
    )
    expect(result.markedContent?.[2]).toEqual(
      text(
        `The Alda bridge opened in 1932.${C} It is 412 metres long. Its engineer was Marta Lindqvist.${U}`
      )
    )
    expect(result.record.marks).toBe(1)
    expect(result.record.entries.map((entry) => entry.occurrences)).toEqual([
      1, 1,
    ])
  })

  it('has nothing to add when the same findings come back', async () => {
    const result = await verifyReply(
      [request, markedReply],
      answering(lines(contradicted))
    )
    expect(result.markedContent).toBeUndefined()
    expect(result.record).toMatchObject({ outcome: 'findings', marks: 0 })
    expect(result.record.entries[0]).toMatchObject({
      valid: true,
      occurrences: 1,
    })
  })
})

describe('verifyReply: when it does not go as planned', () => {
  it('says so when the verifier calls a tool instead of answering, and marks nothing', async () => {
    const result = await verifyReply(
      [request, reply],
      answering(lines(contradicted), {
        finishReason: 'tool-calls',
        toolCalls: ['web_fetch'],
      })
    )
    expect(result.markedContent).toBeUndefined()
    expect(result.record).toMatchObject({
      outcome: 'tool-call',
      toolCalls: ['web_fetch'],
      output: lines(contradicted),
      entries: [],
      marks: 0,
    })
  })

  it('says so when the cap cut the output, and uses the findings that are whole', async () => {
    const cut = JSON.stringify(unsupported).slice(0, 50)
    const byReason = await verifyReply(
      [request, reply],
      answering(`${lines(contradicted)}\n${cut}`, { finishReason: 'length' })
    )
    expect(byReason.record).toMatchObject({
      outcome: 'findings',
      truncated: true,
      marks: 1,
    })
    expect(byReason.record.entries.map((entry) => entry.rejections)).toEqual([
      [],
      ['not-json'],
    ])

    // An engine can say `stop` for an answer it cut: the tokens tell.
    const byTokens = await verifyReply(
      [request, reply],
      answering(lines(contradicted), { outputTokens: 8192 })
    )
    expect(byTokens.record.truncated).toBe(true)
    const below = await verifyReply(
      [request, reply],
      answering(lines(contradicted), { outputTokens: 8191 })
    )
    expect(below.record.truncated).toBe(false)
    const unknown = await verifyReply(
      [request, reply],
      answering(lines(contradicted), { outputTokens: undefined })
    )
    expect(unknown.record.truncated).toBe(false)
  })

  it('says so when the output has neither findings nor NO FINDINGS', async () => {
    const prose = await verifyReply(
      [request, reply],
      answering('The answer looks fine to me.')
    )
    expect(prose.markedContent).toBeUndefined()
    expect(prose.record.outcome).toBe('unreadable')
    expect(prose.record.entries).toEqual([
      {
        raw: 'The answer looks fine to me.',
        valid: false,
        rejections: ['not-json'],
      },
    ])
    const empty = await verifyReply([request, reply], answering(''))
    expect(empty.record).toMatchObject({ outcome: 'unreadable', entries: [] })
  })

  it('says so when no finding passes the checks', async () => {
    const result = await verifyReply(
      [request, reply],
      answering(lines(notInAnswer))
    )
    expect(result.markedContent).toBeUndefined()
    expect(result.record).toMatchObject({ outcome: 'nothing-valid', marks: 0 })
    expect(result.record.entries[0].rejections).toEqual(['quote-not-found'])
  })

  it('records the error of a request that failed', async () => {
    const failing = vi.fn<AskVerifier>(async () => {
      throw new Error('connection refused')
    })
    const result = await verifyReply([request, reply], failing, {
      now: clock(),
    })
    expect(result).toEqual({
      record: {
        at: 1000,
        outcome: 'error',
        seconds: 2.5,
        maxOutputTokens: 8192,
        truncated: false,
        toolCalls: [],
        output: '',
        reasoning: '',
        entries: [],
        marks: 0,
        error: 'connection refused',
      },
    })
  })

  it('records a verification that was stopped, not as an error', async () => {
    const controller = new AbortController()
    const stopped = vi.fn<AskVerifier>(async () => {
      controller.abort()
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      throw error
    })
    const result = await verifyReply([request, reply], stopped, {
      abortSignal: controller.signal,
    })
    expect(result.markedContent).toBeUndefined()
    expect(result.record.outcome).toBe('stopped')
    expect(result.record.error).toBeUndefined()

    // The signal alone is enough: some engines fail with another error.
    const other = vi.fn<AskVerifier>(async () => {
      throw new Error('socket closed')
    })
    const afterAbort = await verifyReply([request, reply], other, {
      abortSignal: controller.signal,
    })
    expect(afterAbort.record.outcome).toBe('stopped')
    // And so is the error, without a signal.
    const byName = vi.fn<AskVerifier>(async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    })
    expect((await verifyReply([request, reply], byName)).record.outcome).toBe(
      'stopped'
    )
  })
})

describe('verifyReply: a reply to a follow-up question', () => {
  // The sources were opened in the first turn: a file the user attached and a
  // page. The second turn opens nothing.
  const first: ThreadMessage = {
    ...message(ChatCompletionRole.User, [text('Read this survey.')]),
    id: 'first',
    metadata: {
      inline_file_contents: [
        { name: 'survey.pdf', content: 'Engineer: Marta Lindqvist.' },
      ],
    },
  }
  const firstReply: ThreadMessage = {
    ...message(ChatCompletionRole.Assistant, [
      call,
      text('It opened in 1932, the survey says.'),
    ]),
    id: 'first-reply',
  }
  const followUp = message(ChatCompletionRole.User, [text('Are you sure?')])
  const lastReply = message(ChatCompletionRole.Assistant, [
    reasoning,
    text(ANSWER),
  ])
  const path = [first, firstReply, followUp, lastReply]

  it('asks about the whole conversation, with the wording for a conversation', async () => {
    const ask = answering('NO FINDINGS')
    const result = await verifyReply(path, ask)

    expect(result.record.outcome).toBe('no-findings')
    const [prompt] = ask.mock.calls[0]
    expect(prompt).toBe(
      verifyRequest(
        [
          '[TURN 1]',
          '[USER REQUEST]',
          'Read this survey.',
          '[ATTACHED FILE] survey.pdf',
          'Engineer: Marta Lindqvist.',
          '',
          '[TOOL CALL] web_fetch',
          '{"url":"https://example.org/alda"}',
          '[TOOL RESULT]',
          SOURCE,
          '',
          '[TURN 2]',
          '[USER REQUEST]',
          'Are you sure?',
          '',
          '[ANSWER]',
          ANSWER,
        ].join('\n'),
        true
      )
    )
    expect(prompt).toContain('<<<CONVERSATION\n[TURN 1]')
    // The first answer is the assistant's own words, not a source.
    expect(prompt).not.toContain('the survey says')
  })

  it('checks a finding against the sources of the earlier turn', async () => {
    const result = await verifyReply(path, answering(lines(contradicted)))
    expect(result.record).toMatchObject({ outcome: 'findings', marks: 1 })
    expect(result.record.entries[0]).toMatchObject({
      valid: true,
      rejections: [],
    })
    expect(result.markedContent).toEqual([
      reasoning,
      text(
        `The Alda bridge opened in 1932.${C} It is 412 metres long. Its engineer was Marta Lindqvist.`
      ),
    ])
  })

  it('checks a finding against the attached file', async () => {
    const wrongEngineer = {
      n: 1,
      verdict: 'contradicted',
      quote: 'It is 412 metres long.',
      source: 'Engineer: Marta Lindqvist.',
      why: 'Made up for the test.',
    }
    const result = await verifyReply(path, answering(lines(wrongEngineer)))
    expect(result.record.entries[0]).toMatchObject({
      valid: true,
      rejections: [],
    })
  })

  // An answer or a request is not a source. A passage taken from one does not
  // make the statement contradicted: it is marked as unverified.
  const unverified = [
    reasoning,
    text(
      `The Alda bridge opened in 1932.${U} It is 412 metres long. Its engineer was Marta Lindqvist.`
    ),
  ]

  it('does not go by a source taken from the answer of the earlier turn', async () => {
    const fromFirstAnswer = {
      ...contradicted,
      source: 'It opened in 1932, the survey says.',
    }
    const result = await verifyReply(path, answering(lines(fromFirstAnswer)))
    expect(result.record).toMatchObject({ outcome: 'findings', marks: 1 })
    expect(result.record.entries[0]).toMatchObject({
      valid: true,
      rejections: [],
      sourceDoubt: 'source-not-found',
      occurrences: 1,
    })
    expect(result.markedContent).toEqual(unverified)
  })

  it('does not go by a source taken from a request or from the answer itself', async () => {
    const fromRequest = { ...contradicted, source: 'Read this survey.' }
    const fromAnswer = { ...contradicted, source: 'It is 412 metres long.' }
    const result = await verifyReply(
      path,
      answering(lines(fromRequest, fromAnswer))
    )
    expect(result.record).toMatchObject({ outcome: 'findings', marks: 1 })
    expect(result.record.entries.map((entry) => entry.sourceDoubt)).toEqual([
      'source-not-found',
      'source-not-found',
    ])
    expect(result.markedContent).toEqual(unverified)
  })

  it('goes by a source copied with other spaces and line ends', async () => {
    const brokenLine = {
      ...contradicted,
      source: 'Opened to traffic in\n1934.  Total length: 412 m.',
    }
    const result = await verifyReply(path, answering(lines(brokenLine)))
    expect(result.record.entries[0]).not.toHaveProperty('sourceDoubt')
    expect(result.markedContent?.[1]).toEqual(
      text(
        `The Alda bridge opened in 1932.${C} It is 412 metres long. Its engineer was Marta Lindqvist.`
      )
    )
  })

  it('does not ask when no turn of the conversation has a source', async () => {
    const ask = answering('NO FINDINGS')
    const result = await verifyReply(
      [
        message(ChatCompletionRole.User, [text('Hello')]),
        message(ChatCompletionRole.Assistant, [text('Hello.')]),
        followUp,
        lastReply,
      ],
      ask
    )
    expect(ask).not.toHaveBeenCalled()
    expect(result.record.outcome).toBe('no-sources')
  })

  it('sends the last reply without its marks, and leaves the earlier turns as they are', async () => {
    const ask = answering('NO FINDINGS')
    const marked = message(ChatCompletionRole.Assistant, [
      text(`The Alda bridge opened in 1932.${C} It is 412 metres long.${U}`),
    ])
    await verifyReply([first, firstReply, followUp, marked], ask)
    const [prompt] = ask.mock.calls[0]
    expect(prompt).toContain(
      '[ANSWER]\nThe Alda bridge opened in 1932. It is 412 metres long.\nCONVERSATION>>>'
    )
    expect(prompt).toContain(`[TOOL RESULT]\n${SOURCE}\n`)
  })
})
