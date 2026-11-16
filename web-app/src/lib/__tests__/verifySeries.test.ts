import { describe, it, expect, vi } from 'vitest'
import {
  ChatCompletionRole,
  ContentType,
  MessageStatus,
  type ThreadContent,
  type ThreadMessage,
} from '@janhq/core'
import { CONTRADICTED_MARK, UNVERIFIED_MARK } from '../verifyMarks'
import { verifyReply, type AskVerifier } from '../verifyReply'
import { verifySeries, VERIFY_REPETITIONS_MAX } from '../verifySeries'

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
const call = {
  type: ContentType.ToolCall,
  tool_call_id: 'c1',
  tool_name: 'web_fetch',
  input: { url: 'https://example.org/alda' },
  output: 'Alda bridge. Opened to traffic in 1934. Total length: 412 m.',
} as ThreadContent

const U = ` ${UNVERIFIED_MARK}`
const C = ` ${CONTRADICTED_MARK}`
const request = message(ChatCompletionRole.User, [
  text('Tell me about the Alda bridge.'),
])
const reply = message(ChatCompletionRole.Assistant, [
  call,
  text(
    'The Alda bridge opened in 1932. It is 412 metres long. Its engineer was Marta Lindqvist.'
  ),
])
const path = [request, reply]
const textOf = (content: ThreadContent[] | undefined) =>
  content?.find((part) => part.type === ContentType.Text)?.text?.value

const year = {
  n: 1,
  verdict: 'contradicted',
  quote: 'The Alda bridge opened in 1932.',
  source: 'Opened to traffic in 1934.',
  why: 'The source gives 1934.',
}
const engineer = {
  n: 1,
  verdict: 'unsupported',
  quote: 'Its engineer was Marta Lindqvist.',
  source: null,
  why: 'No passage names the engineer.',
}
const notInAnswer = {
  n: 1,
  verdict: 'unsupported',
  quote: 'It is 412 meters long.',
  source: null,
  why: 'Spelled differently in the answer.',
}
const lines = (...findings: object[]) =>
  findings.map((finding) => JSON.stringify(finding)).join('\n')

type Answer = Awaited<ReturnType<AskVerifier>>
const answer = (output: string): Answer => ({
  text: output,
  reasoning: 'I compared each sentence.',
  finishReason: 'stop',
  inputTokens: 900,
  outputTokens: 300,
  toolCalls: [],
  toolInputs: [],
  servedModel: 'q8-served',
  model: { provider: 'strata', id: 'q8' },
})
/** A verifier that gives one of `outputs` at each run; an Error is thrown. */
const answering = (...outputs: Array<string | Error>) => {
  let run = 0
  return vi.fn<AskVerifier>(async () => {
    const output = outputs[run++]
    if (output instanceof Error) throw output
    return answer(output)
  })
}
const aborted = () =>
  Object.assign(new Error('This operation was aborted'), {
    name: 'AbortError',
  })
/** A clock that moves 2.5 seconds at every reading. */
const clock = () => {
  let time = 1000
  return () => (time += 2500) - 2500
}

describe('verifySeries: one run', () => {
  it('gives what a single verification gives', async () => {
    const series = await verifySeries(path, answering(lines(year)), {
      repetitions: 1,
      now: clock(),
    })
    const single = await verifyReply(path, answering(lines(year)), {
      now: clock(),
    })

    expect(series).toEqual(single)
    expect(series.record.runs).toBeUndefined()
    expect(series.record.repetitions).toBeUndefined()
  })

  it('gives the run alone when the first one is stopped, and asks no more', async () => {
    const ask = answering(aborted(), lines(year))
    const { record } = await verifySeries(path, ask, { repetitions: 3 })

    expect(ask).toHaveBeenCalledTimes(1)
    expect(record.outcome).toBe('stopped')
    expect(record.runs).toBeUndefined()
  })
})

describe('verifySeries: several runs', () => {
  it('asks the same thing at every run, and says which run starts', async () => {
    const ask = answering('NO FINDINGS', 'NO FINDINGS', 'NO FINDINGS')
    const controller = new AbortController()
    const onProgress = vi.fn()
    const onRun = vi.fn()
    await verifySeries(path, ask, {
      repetitions: 3,
      onRun,
      maxOutputTokens: 16384,
      abortSignal: controller.signal,
      onProgress,
    })

    expect(ask).toHaveBeenCalledTimes(3)
    expect(ask.mock.calls[1]).toEqual(ask.mock.calls[0])
    expect(ask.mock.calls[2]).toEqual(ask.mock.calls[0])
    expect(ask.mock.calls[0][1]).toEqual({
      maxOutputTokens: 16384,
      abortSignal: controller.signal,
      onProgress,
    })
    expect(onRun.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })

  it('puts together what the runs reported, and marks it once', async () => {
    const ask = answering(lines(year), 'NO FINDINGS', lines(engineer, year))
    const { record, markedContent } = await verifySeries(path, ask, {
      repetitions: 3,
      now: clock(),
    })

    expect(record.outcome).toBe('findings')
    expect(
      record.entries.map((entry) => [entry.finding?.quote, entry.runs])
    ).toEqual([
      [year.quote, 2],
      [engineer.quote, 1],
    ])
    expect(record.entries.every((entry) => entry.valid)).toBe(true)
    expect(record.entries.map((entry) => entry.occurrences)).toEqual([1, 1])
    expect(record.marks).toBe(2)
    expect(textOf(markedContent)).toBe(
      `The Alda bridge opened in 1932.${C} It is 412 metres long. Its engineer was Marta Lindqvist.${U}`
    )
  })

  it('keeps the record of every run, and counts for all of them', async () => {
    const ask = answering(lines(year), 'NO FINDINGS', lines(engineer, year))
    const { record } = await verifySeries(path, ask, {
      repetitions: 3,
      maxOutputTokens: 16384,
      now: clock(),
    })

    expect(record.repetitions).toBe(3)
    expect(record.runs?.map((run) => run.outcome)).toEqual([
      'findings',
      'no-findings',
      'findings',
    ])
    expect(record.runs?.[2].entries).toHaveLength(2)
    expect(record.runs?.[0].output).toBe(lines(year))
    expect(record.runs?.[0].reasoning).toBe('I compared each sentence.')
    // The series starts with its first run and ends after the last one.
    expect(record.at).toBe(record.runs?.[0].at)
    expect(record.at).toBe(1000)
    expect(record.seconds).toBe(15)
    expect(record.maxOutputTokens).toBe(16384)
    expect(record.inputTokens).toBe(2700)
    expect(record.outputTokens).toBe(900)
    expect(record.servedModel).toBe('q8-served')
    expect(record.model).toEqual({ provider: 'strata', id: 'q8' })
    expect(record.truncated).toBe(false)
    expect(record.output).toBe('')
    expect(record.error).toBeUndefined()
    expect(JSON.parse(JSON.stringify(record))).toEqual(record)
  })

  it('says the output was cut when it was in one of the runs', async () => {
    let run = 0
    const ask = vi.fn<AskVerifier>(async () => ({
      ...answer('NO FINDINGS'),
      outputTokens: ++run === 2 ? 16384 : 300,
    }))
    const { record } = await verifySeries(path, ask, {
      repetitions: 3,
      maxOutputTokens: 16384,
    })

    expect(record.runs?.map((one) => one.truncated)).toEqual([
      false,
      true,
      false,
    ])
    expect(record.truncated).toBe(true)
  })

  it('takes two quotes that share words of the answer as one statement', async () => {
    const longer = {
      ...engineer,
      quote: 'opened in 1932. It is 412 metres long.',
      why: 'No passage says it like this.',
    }
    const ask = answering(lines(longer), lines(year))
    const { record, markedContent } = await verifySeries(path, ask, {
      repetitions: 2,
    })

    expect(
      record.entries.map((entry) => [entry.finding?.quote, entry.runs])
    ).toEqual([[year.quote, 2]])
    // One mark for the statement, where the finding that stands for it ends.
    expect(record.marks).toBe(1)
    expect(textOf(markedContent)).toBe(
      `The Alda bridge opened in 1932.${C} It is 412 metres long. Its engineer was Marta Lindqvist.`
    )
  })

  it('keeps apart two statements that only touch', async () => {
    const length = {
      ...engineer,
      quote: ' It is 412 metres long.',
      why: 'The source gives metres as m.',
    }
    const { record } = await verifySeries(
      path,
      answering(lines(year), lines(length)),
      { repetitions: 2 }
    )

    expect(
      record.entries.map((entry) => [entry.finding?.quote, entry.runs])
    ).toEqual([
      [year.quote, 1],
      [length.quote, 1],
    ])
  })

  it('keeps apart the same place of two blocks of text', async () => {
    const blocks = message(ChatCompletionRole.Assistant, [
      text('Opened in 1932, they say.'),
      call,
      text('Engineer: Marta Lindqvist.'),
    ])
    const first = { ...engineer, quote: 'Opened in 1932' }
    const second = { ...engineer, quote: 'Engineer: Marta' }
    const { record } = await verifySeries(
      [request, blocks],
      answering(lines(first), lines(second)),
      { repetitions: 2 }
    )

    expect(record.entries.map((entry) => entry.runs)).toEqual([1, 1])
  })

  it('looks at every place where a quote is', async () => {
    const twice = message(ChatCompletionRole.Assistant, [
      call,
      text(
        'It opened in 1932. Everyone repeats that it opened in 1932 exactly.'
      ),
    ])
    const short = { ...engineer, quote: 'opened in 1932' }
    const second = { ...engineer, quote: 'opened in 1932 exactly.' }
    const { record } = await verifySeries(
      [request, twice],
      answering(lines(short), lines(second)),
      { repetitions: 2 }
    )

    expect(
      record.entries.map((entry) => [entry.runs, entry.occurrences])
    ).toEqual([[2, 2]])
  })

  it('counts a statement once for a run that reported it twice', async () => {
    const again = { ...year, n: 2, quote: 'opened in 1932' }
    const { record } = await verifySeries(
      path,
      answering(lines(year, again), 'NO FINDINGS'),
      { repetitions: 2 }
    )

    expect(record.entries.map((entry) => entry.runs)).toEqual([1])
    expect(record.marks).toBe(1)
  })

  it('finds the statements of a reply that already has marks', async () => {
    const marked = message(ChatCompletionRole.Assistant, [
      call,
      text(
        `The Alda bridge opened in 1932.${C} It is 412 metres long. Its engineer was Marta Lindqvist.`
      ),
    ])
    const longer = {
      ...engineer,
      quote: 'opened in 1932. It is 412 metres long.',
    }
    const { record, markedContent } = await verifySeries(
      [request, marked],
      answering(lines(year), lines(longer)),
      { repetitions: 2 }
    )

    expect(record.entries.map((entry) => entry.runs)).toEqual([2])
    // The mark was there already: nothing to write.
    expect(record.marks).toBe(0)
    expect(markedContent).toBeUndefined()
  })

  it('lets a run that found the statement contradicted stand for it', async () => {
    const asUnsupported = { ...year, verdict: 'unsupported', source: null }
    // A passage that is not in the sources: used as unsupported.
    const unconfirmed = { ...year, source: 'Opened in 1935.' }
    const ask = answering(lines(asUnsupported), lines(unconfirmed), lines(year))
    const { record, markedContent } = await verifySeries(path, ask, {
      repetitions: 3,
    })

    expect(record.entries).toHaveLength(1)
    expect(record.entries[0]).toMatchObject({
      finding: year,
      runs: 3,
      occurrences: 1,
    })
    expect(record.entries[0].sourceDoubt).toBeUndefined()
    expect(textOf(markedContent)).toContain(`in 1932.${C}`)
    expect(textOf(markedContent)).not.toContain(U)
  })

  it('counts once a quote that no single block of text holds', async () => {
    const split = message(ChatCompletionRole.Assistant, [
      text('The Alda bridge opened in 1932.'),
      call,
      text('It is 412 metres long.'),
    ])
    const across = { ...engineer, quote: 'opened in 1932.\nIt is 412 metres' }
    const { record, markedContent } = await verifySeries(
      [request, split],
      answering(lines(across), lines(across)),
      { repetitions: 2 }
    )

    expect(
      record.entries.map((entry) => [entry.runs, entry.occurrences])
    ).toEqual([[2, 0]])
    expect(record.outcome).toBe('findings')
    expect(markedContent).toBeUndefined()
  })

  it('reports no findings when no run reported any', async () => {
    const { record, markedContent } = await verifySeries(
      path,
      answering('NO FINDINGS', 'NO FINDINGS'),
      { repetitions: 2 }
    )

    expect(record.outcome).toBe('no-findings')
    expect(record.entries).toEqual([])
    expect(record.marks).toBe(0)
    expect(markedContent).toBeUndefined()
  })

  it('reports that nothing passed the checks when a run gave nothing usable', async () => {
    const { record } = await verifySeries(
      path,
      answering('NO FINDINGS', lines(notInAnswer)),
      { repetitions: 2 }
    )

    expect(record.outcome).toBe('nothing-valid')
    expect(record.entries).toEqual([])
    expect(record.runs?.map((run) => run.outcome)).toEqual([
      'no-findings',
      'nothing-valid',
    ])
  })
})

describe('verifySeries: a series that does not get to the end', () => {
  it('ends at a run that is stopped, with what the runs before it found', async () => {
    const ask = answering(lines(year), aborted(), lines(engineer))
    const { record, markedContent } = await verifySeries(path, ask, {
      repetitions: 3,
    })

    expect(ask).toHaveBeenCalledTimes(2)
    expect(record.repetitions).toBe(3)
    expect(record.runs?.map((run) => run.outcome)).toEqual([
      'findings',
      'stopped',
    ])
    expect(record.outcome).toBe('findings')
    expect(record.entries.map((entry) => entry.runs)).toEqual([1])
    expect(record.outputTokens).toBe(300)
    expect(record.servedModel).toBe('q8-served')
    expect(record.model).toEqual({ provider: 'strata', id: 'q8' })
    expect(record.error).toBeUndefined()
    expect(textOf(markedContent)).toContain(`in 1932.${C}`)
  })

  it('ends at a run that fails, and says why', async () => {
    const ask = answering('NO FINDINGS', new Error('engine down'), lines(year))
    const { record } = await verifySeries(path, ask, { repetitions: 3 })

    expect(ask).toHaveBeenCalledTimes(2)
    expect(record.runs?.map((run) => run.outcome)).toEqual([
      'no-findings',
      'error',
    ])
    expect(record.outcome).toBe('no-findings')
    expect(record.error).toBe('engine down')
  })
})

describe('verifySeries: how many runs', () => {
  it('can be asked for five at most', () => {
    expect(VERIFY_REPETITIONS_MAX).toBe(5)
  })
})
