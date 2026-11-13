import { describe, it, expect, beforeEach } from 'vitest'
import {
  ChatCompletionRole,
  ContentType,
  MessageStatus,
  type ThreadContent,
  type ThreadMessage,
} from '@janhq/core'
import {
  backfillParentIds,
  computeActivePath,
  getVersionInfo,
  hasBranching,
  withActiveChild,
} from '../message-branching'
import type { AskVerifier } from '../verifyReply'
import { runVerification, type VerificationThread } from '../verifyRun'
import { verificationsOf } from '../verifyWrite'
import { useVerification } from '@/stores/verification-store'

// A made-up turn: nothing here comes from a real conversation.
const SOURCE =
  'The Alda bridge was opened to traffic in 1934. It is 412 meters long.'
const ANSWER =
  'The Alda bridge opened in 1932. It is 412 meters long. Its engineer was Marta Lindqvist.'
const MARKED =
  'The Alda bridge opened in 1932. (contraddetto dalla fonte) It is 412 meters long. Its engineer was Marta Lindqvist. (non verificato)'
const FINDINGS = [
  JSON.stringify({
    n: 1,
    verdict: 'contradicted',
    quote: 'The Alda bridge opened in 1932.',
    source: 'The Alda bridge was opened to traffic in 1934.',
    why: 'The source says 1934.',
  }),
  JSON.stringify({
    n: 2,
    verdict: 'unsupported',
    quote: 'Its engineer was Marta Lindqvist.',
    source: null,
    why: 'No passage names the engineer.',
  }),
].join('\n')

const text = (value: string): ThreadContent => ({
  type: ContentType.Text,
  text: { value, annotations: [] },
})
const message = (
  id: string,
  role: ChatCompletionRole,
  content: ThreadContent[],
  metadata?: Record<string, unknown>
): ThreadMessage => ({
  id,
  object: 'thread.message',
  thread_id: 't1',
  role,
  content,
  status: MessageStatus.Ready,
  created_at: Number(id.slice(1)),
  completed_at: Number(id.slice(1)),
  metadata,
})
const reasoning: ThreadContent = {
  type: ContentType.Reasoning,
  text: { value: 'I recall 1932.', annotations: [] },
}
const call = (output: unknown) =>
  ({
    type: ContentType.ToolCall,
    tool_call_id: 'c1',
    tool_name: 'web_fetch',
    input: { url: 'https://example.org/alda' },
    output,
  }) as ThreadContent

const turn = (replyContent: ThreadContent[]) => [
  message('m1', ChatCompletionRole.User, [text('Hello')]),
  message('m2', ChatCompletionRole.Assistant, [text('Hello.')]),
  message('m3', ChatCompletionRole.User, [text('When did the bridge open?')]),
  message('m4', ChatCompletionRole.Assistant, replyContent, {
    usage: { outputTokens: 30 },
  }),
]
const withSource = () => turn([reasoning, call(SOURCE), text(ANSWER)])

const answerOf = (output: string): Awaited<ReturnType<AskVerifier>> => ({
  text: output,
  reasoning: 'checking',
  finishReason: 'stop',
  inputTokens: 900,
  outputTokens: 120,
  toolCalls: [],
  toolInputs: [],
  servedModel: 'q2-served',
  model: { provider: 'strata', id: 'q2-model' },
})

/** A thread kept in memory, changed the way the chat screen changes its own. */
function threadOf(initial: ThreadMessage[], ask: AskVerifier) {
  const state = {
    stored: initial,
    busy: false,
    /** The ids on screen, each time the conversation was put on screen. */
    shown: [] as string[][],
    /** The id of each message written, in the order of the writes. */
    updated: [] as string[],
    ids: 0,
  }
  const thread: VerificationThread = {
    id: 't1',
    messages: () => state.stored,
    activeRootId: () => undefined,
    busy: () => state.busy,
    ask,
    maxOutputTokens: 16384,
    updateMessage: (next) => {
      state.updated.push(next.id)
      state.stored = state.stored.map((m) => (m.id === next.id ? next : m))
    },
    addMessage: (added) => {
      state.stored = [...state.stored, added]
    },
    show: () => {
      state.shown.push(computeActivePath(state.stored).map((m) => m.id))
    },
    newId: () => `n${++state.ids}`,
  }
  return { thread, state }
}

/** A verifier that answers when the test says so. */
function waitingVerifier() {
  let settle!: {
    resolve: (answer: Awaited<ReturnType<AskVerifier>>) => void
    reject: (error: unknown) => void
  }
  const asked: Array<Parameters<AskVerifier>> = []
  const ask: AskVerifier = (prompt, options) => {
    asked.push([prompt, options])
    return new Promise((resolve, reject) => {
      settle = { resolve, reject }
      options.abortSignal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      )
    })
  }
  return {
    ask,
    asked,
    answer: (output: string) => settle.resolve(answerOf(output)),
    fail: (error: unknown) => settle.reject(error),
  }
}
const verification = () => useVerification.getState()
const byId = (messages: ThreadMessage[], id: string) =>
  messages.find((m) => m.id === id)!
const textOf = (m: ThreadMessage) => m.content[m.content.length - 1].text?.value

describe('runVerification', () => {
  beforeEach(() => {
    useVerification.setState({ running: {}, records: {} })
  })

  it('records the findings in the reply and shows a version with the marks', async () => {
    const { thread, state } = threadOf(
      backfillParentIds(withSource()),
      async () => answerOf(FINDINGS)
    )
    const before = byId(state.stored, 'm4')
    let clock = 1000
    const run = await runVerification(thread, 'm4', () => (clock += 500))

    expect(run).toMatchObject({ started: true, version: 'shown' })
    if (!run.started) throw new Error('not started')
    expect(run.record).toMatchObject({ outcome: 'findings', marks: 2 })

    // The reply: same content, one record more.
    const reply = byId(state.stored, 'm4')
    expect(reply.content).toEqual(before.content)
    expect(textOf(reply)).toBe(ANSWER)
    expect(verificationsOf(reply.metadata)).toEqual([run.record])
    expect(reply.metadata).toEqual({
      ...before.metadata,
      verifications: [run.record],
    })

    // The version: beside the reply, with the marks, the reasoning and the
    // tool call with its result.
    expect(state.stored.map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'n1',
    ])
    const version = byId(state.stored, 'n1')
    expect(version.metadata?.parentId).toBe('m3')
    expect(version.metadata?.verifiedFrom).toBe('m4')
    expect(verificationsOf(version.metadata)).toEqual([run.record])
    expect(version.content).toEqual([reasoning, call(SOURCE), text(MARKED)])
    expect(version.created_at).toBeGreaterThan(run.record.at)
    expect(getVersionInfo(state.stored, version)).toEqual({
      index: 2,
      count: 2,
    })

    // It is the one shown, and the screen was rewritten once, after it was.
    expect(byId(state.stored, 'm3').metadata?.activeChildId).toBe('n1')
    expect(state.shown).toEqual([['m1', 'm2', 'm3', 'n1']])

    // Only the question and the reply were written again, once each.
    expect(state.updated).toEqual(['m3', 'm4'])

    // Nothing is running any more, and the reply has its record at hand.
    expect(verification().running).toEqual({})
    expect(verification().records).toEqual({ m4: run.record })
  })

  it('adds the version to a reply that already has versions, and shows the new one', async () => {
    const [m1, m2, m3, m4] = backfillParentIds(withSource())
    const older = message('m0', ChatCompletionRole.Assistant, [text('1934.')], {
      parentId: 'm3',
    })
    const { thread, state } = threadOf(
      [m1, m2, withActiveChild(m3, 'm4'), older, m4],
      async () => answerOf(FINDINGS)
    )
    const run = await runVerification(thread, 'm4')

    expect(run).toMatchObject({ started: true, version: 'shown' })
    const version = byId(state.stored, 'n1')
    expect(getVersionInfo(state.stored, version)).toEqual({
      index: 3,
      count: 3,
    })
    expect(byId(state.stored, 'm3').metadata?.activeChildId).toBe('n1')
    expect(state.shown).toEqual([['m1', 'm2', 'm3', 'n1']])
    expect(byId(state.stored, 'm0')).toBe(older)
  })

  it('adds the record to the reply as it is stored when the verifier answers', async () => {
    const verifier = waitingVerifier()
    const { thread, state } = threadOf(
      backfillParentIds(withSource()),
      verifier.ask
    )
    const run = runVerification(thread, 'm4')
    const reply = byId(state.stored, 'm4')
    thread.updateMessage({
      ...reply,
      metadata: { ...reply.metadata, tokenSpeed: { tokensPerSecond: 31 } },
    })
    verifier.answer(FINDINGS)
    await run

    for (const id of ['m4', 'n1']) {
      const metadata = byId(state.stored, id).metadata
      expect(metadata?.tokenSpeed).toEqual({ tokensPerSecond: 31 })
      expect(verificationsOf(metadata)).toHaveLength(1)
    }
  })

  it('adds the record to the reply as it is stored, with nothing to mark too', async () => {
    const verifier = waitingVerifier()
    const { thread, state } = threadOf(withSource(), verifier.ask)
    const run = runVerification(thread, 'm4')
    const reply = byId(state.stored, 'm4')
    thread.updateMessage({
      ...reply,
      metadata: { ...reply.metadata, tokenSpeed: { tokensPerSecond: 31 } },
    })
    verifier.answer('NO FINDINGS')
    await run

    const metadata = byId(state.stored, 'm4').metadata
    expect(metadata?.tokenSpeed).toEqual({ tokensPerSecond: 31 })
    expect(verificationsOf(metadata)).toHaveLength(1)
  })

  it('links the messages of a thread that never had versions before adding one', async () => {
    const { thread, state } = threadOf(withSource(), async () =>
      answerOf(FINDINGS)
    )
    expect(hasBranching(state.stored)).toBe(false)
    const run = await runVerification(thread, 'm4')

    expect(run).toMatchObject({ started: true, version: 'shown' })
    expect(state.stored.map((m) => [m.id, m.metadata?.parentId])).toEqual([
      ['m1', null],
      ['m2', 'm1'],
      ['m3', 'm2'],
      ['m4', 'm3'],
      ['n1', 'm3'],
    ])
    expect(verificationsOf(byId(state.stored, 'm4').metadata)).toHaveLength(1)
    expect(byId(state.stored, 'm3').metadata?.activeChildId).toBe('n1')
    expect(state.shown).toEqual([['m1', 'm2', 'm3', 'n1']])
    // Each message is written once, with all that changes in it.
    expect(state.updated).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('asks with the cap of the thread, and records it', async () => {
    const caps: number[] = []
    const { thread } = threadOf(withSource(), async (_prompt, options) => {
      caps.push(options.maxOutputTokens)
      return answerOf('NO FINDINGS')
    })
    const run = await runVerification(thread, 'm4')

    if (!run.started) throw new Error('not started')
    expect(caps).toEqual([16384])
    expect(run.record.maxOutputTokens).toBe(16384)
  })

  it('records a verification that found nothing, and adds no version', async () => {
    const initial = withSource()
    const { thread, state } = threadOf(initial, async () =>
      answerOf('NO FINDINGS')
    )
    const run = await runVerification(thread, 'm4')

    expect(run).toMatchObject({ started: true, version: 'none' })
    if (!run.started) throw new Error('not started')
    expect(run.record.outcome).toBe('no-findings')
    expect(state.stored.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(verificationsOf(byId(state.stored, 'm4').metadata)).toEqual([
      run.record,
    ])
    // Nothing else of the thread changed: it still has no versions.
    expect(state.stored.slice(0, 3)).toEqual(initial.slice(0, 3))
    expect(hasBranching(state.stored)).toBe(false)
    expect(state.updated).toEqual(['m4'])
    expect(state.shown).toEqual([])
    expect(verification().records.m4).toBe(run.record)
  })

  it('records that a turn without tool results was not verified, without asking', async () => {
    const verifier = waitingVerifier()
    const { thread, state } = threadOf(turn([text(ANSWER)]), verifier.ask)
    const run = await runVerification(thread, 'm4')

    expect(run).toMatchObject({ started: true, version: 'none' })
    expect(verifier.asked).toHaveLength(0)
    expect(
      verificationsOf(byId(state.stored, 'm4').metadata).map((r) => r.outcome)
    ).toEqual(['no-sources'])
    expect(verification().running).toEqual({})
  })

  it('asks about the whole conversation: a reply can rest on what an earlier turn opened', async () => {
    const verifier = waitingVerifier()
    const { thread, state } = threadOf(
      [
        message('m1', ChatCompletionRole.User, [text('Open the page.')]),
        message('m2', ChatCompletionRole.Assistant, [
          call(SOURCE),
          text('Opened.'),
        ]),
        message('m3', ChatCompletionRole.User, [text('When did it open?')]),
        message('m4', ChatCompletionRole.Assistant, [text(ANSWER)]),
      ],
      verifier.ask
    )
    const run = runVerification(thread, 'm4')

    expect(verifier.asked).toHaveLength(1)
    expect(verifier.asked[0][0]).toContain(`[TOOL RESULT]\n${SOURCE}\n`)
    expect(verifier.asked[0][0]).toContain('[TURN 2]\n[USER REQUEST]\nWhen did')
    verifier.answer(FINDINGS)
    expect(await run).toMatchObject({ started: true, version: 'shown' })
    expect(textOf(byId(state.stored, 'n1'))).toBe(MARKED)
  })

  it('does not start on a reply that is not the last one shown', async () => {
    const verifier = waitingVerifier()
    const { thread, state } = threadOf(withSource(), verifier.ask)
    const before = state.stored

    expect(await runVerification(thread, 'm2')).toEqual({ started: false })
    expect(await runVerification(thread, 'm9')).toEqual({ started: false })
    expect(verifier.asked).toHaveLength(0)
    expect(state.stored).toBe(before)
    expect(verification().running).toEqual({})
    expect(verification().records).toEqual({})
  })

  it('does not start while a turn is running', async () => {
    const verifier = waitingVerifier()
    const { thread, state } = threadOf(withSource(), verifier.ask)
    state.busy = true

    expect(await runVerification(thread, 'm4')).toEqual({ started: false })
    expect(verifier.asked).toHaveLength(0)
    expect(verification().running).toEqual({})
  })

  it('does not start twice on the same reply', async () => {
    const verifier = waitingVerifier()
    const { thread, state } = threadOf(withSource(), verifier.ask)
    const first = runVerification(thread, 'm4')
    const controller = verification().running.m4.controller

    expect(await runVerification(thread, 'm4')).toEqual({ started: false })
    expect(verifier.asked).toHaveLength(1)
    // The first one is still the one running, and ends as usual.
    expect(verification().running.m4.controller).toBe(controller)
    verifier.answer('NO FINDINGS')
    expect(await first).toMatchObject({ started: true, version: 'none' })
    expect(verificationsOf(byId(state.stored, 'm4').metadata)).toHaveLength(1)
  })

  it('is seen running, with its progress, until the verifier answers', async () => {
    const verifier = waitingVerifier()
    const { thread } = threadOf(withSource(), verifier.ask)
    let clock = 0
    const run = runVerification(thread, 'm4', () => clock)

    expect(verification().running.m4).toMatchObject({
      threadId: 't1',
      characters: 0,
    })
    const [prompt, options] = verifier.asked[0]
    expect(prompt).toContain(ANSWER)
    expect(options.abortSignal).toBe(
      verification().running.m4.controller.signal
    )

    // The count on screen follows the verifier, four times a second at most.
    const progress = (at: number, characters: number) => {
      clock = at
      options.onProgress?.(characters)
      return verification().running.m4.characters
    }
    expect(progress(0, 10)).toBe(10)
    expect(progress(100, 400)).toBe(10)
    expect(progress(249, 900)).toBe(10)
    expect(progress(250, 1000)).toBe(1000)
    expect(progress(499, 1900)).toBe(1000)
    expect(progress(500, 2000)).toBe(2000)

    verifier.answer('NO FINDINGS')
    await run
    expect(verification().running).toEqual({})
  })

  it('stops when it is stopped, and records that it was', async () => {
    const verifier = waitingVerifier()
    const { thread, state } = threadOf(withSource(), verifier.ask)
    const run = runVerification(thread, 'm4')

    verification().stop('m4')
    expect(verification().running).toEqual({})
    const result = await run

    expect(result).toMatchObject({ started: true, version: 'none' })
    expect(
      verificationsOf(byId(state.stored, 'm4').metadata).map((r) => r.outcome)
    ).toEqual(['stopped'])
    expect(state.stored).toHaveLength(4)
    expect(state.shown).toEqual([])
    expect(verification().records.m4.outcome).toBe('stopped')
  })

  it('records the stop on the reply even when a turn has started meanwhile', async () => {
    const verifier = waitingVerifier()
    const { thread, state } = threadOf(withSource(), verifier.ask)
    const run = runVerification(thread, 'm4')

    // What Regenerate does: it ends the verification and starts a turn.
    verification().stopThread('t1')
    state.busy = true

    expect(await run).toMatchObject({ started: true, version: 'none' })
    expect(
      verificationsOf(byId(state.stored, 'm4').metadata).map((r) => r.outcome)
    ).toEqual(['stopped'])
    expect(state.updated).toEqual(['m4'])
    expect(state.shown).toEqual([])
  })

  it('can be started again right after a stop, before the stopped one has ended', async () => {
    const answers: Array<(output: string) => void> = []
    const progress: Array<((characters: number) => void) | undefined> = []
    const { thread, state } = threadOf(withSource(), (_prompt, options) => {
      progress.push(options.onProgress)
      return new Promise((resolve, reject) => {
        answers.push((output) => resolve(answerOf(output)))
        // An engine that takes its time to give up: the request ends a
        // moment after the stop, not with it.
        options.abortSignal?.addEventListener('abort', () =>
          setTimeout(() =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          )
        )
      })
    })
    const first = runVerification(thread, 'm4')
    verification().stop('m4')
    const second = runVerification(thread, 'm4')
    const controller = verification().running.m4.controller

    // The stopped one ends now: the second one is still the one running, and
    // text the first one still receives does not move its count.
    expect(await first).toMatchObject({ started: true, version: 'none' })
    expect(verification().running.m4.controller).toBe(controller)
    progress[0]?.(5000)
    expect(verification().running.m4.characters).toBe(0)
    progress[1]?.(70)
    expect(verification().running.m4.characters).toBe(70)

    answers[1]('NO FINDINGS')
    expect(await second).toMatchObject({ started: true, version: 'none' })
    expect(verification().running).toEqual({})
    expect(
      verificationsOf(byId(state.stored, 'm4').metadata).map((r) => r.outcome)
    ).toEqual(['stopped', 'no-findings'])
  })

  it('records a request that failed, and is no longer running', async () => {
    const verifier = waitingVerifier()
    const { thread, state } = threadOf(withSource(), verifier.ask)
    const run = runVerification(thread, 'm4')
    verifier.fail(new Error('connection refused'))
    const result = await run

    expect(result).toMatchObject({ started: true, version: 'none' })
    expect(verificationsOf(byId(state.stored, 'm4').metadata)[0]).toMatchObject(
      {
        outcome: 'error',
        error: 'connection refused',
      }
    )
    expect(verification().running).toEqual({})
  })

  describe('when the conversation moved on while the verifier was working', () => {
    const start = () => {
      const verifier = waitingVerifier()
      const made = threadOf(backfillParentIds(withSource()), verifier.ask)
      return { ...made, verifier, run: runVerification(made.thread, 'm4') }
    }
    const expectRecordOnly = async (
      made: ReturnType<typeof start>,
      stored: number
    ) => {
      const result = await made.run
      expect(result).toMatchObject({ started: true, version: 'skipped' })
      const reply = byId(made.state.stored, 'm4')
      expect(verificationsOf(reply.metadata).map((r) => r.outcome)).toEqual([
        'findings',
      ])
      expect(textOf(reply)).toBe(ANSWER)
      // No version was added and the screen was left alone.
      expect(made.state.stored).toHaveLength(stored)
      expect(made.state.stored.some((m) => m.metadata?.verifiedFrom)).toBe(
        false
      )
      expect(made.state.shown).toEqual([])
      expect(made.state.updated.filter((id) => id === 'm4')).toEqual(['m4'])
    }

    it('keeps the findings and writes no version after a new message', async () => {
      const made = start()
      made.thread.addMessage(
        message('m5', ChatCompletionRole.User, [text('And then?')], {
          parentId: 'm4',
        })
      )
      made.verifier.answer(FINDINGS)
      await expectRecordOnly(made, 5)
    })

    it('keeps the findings and writes no version when another version is shown', async () => {
      const made = start()
      const other = message(
        'm5',
        ChatCompletionRole.Assistant,
        [text('In 1934.')],
        { parentId: 'm3' }
      )
      made.thread.addMessage(other)
      made.thread.updateMessage(
        withActiveChild(byId(made.state.stored, 'm3'), 'm5')
      )
      made.verifier.answer(FINDINGS)
      await expectRecordOnly(made, 5)
      expect(byId(made.state.stored, 'm3').metadata?.activeChildId).toBe('m5')
    })

    it('keeps the findings and writes no version under a turn that is running', async () => {
      const made = start()
      made.state.busy = true
      made.verifier.answer(FINDINGS)
      await expectRecordOnly(made, 4)
    })

    it('writes nothing when the reply is no longer there', async () => {
      const made = start()
      made.state.stored = []
      made.verifier.answer(FINDINGS)
      expect(await made.run).toMatchObject({
        started: true,
        version: 'skipped',
      })
      expect(made.state.stored).toEqual([])
      expect(made.state.shown).toEqual([])
      expect(verification().running).toEqual({})
    })

    it('writes nothing, with nothing to mark, when the reply is no longer there', async () => {
      const made = start()
      made.state.stored = []
      made.verifier.answer('NO FINDINGS')
      expect(await made.run).toMatchObject({ started: true, version: 'none' })
      expect(made.state.stored).toEqual([])
    })
  })

  it('verifies the marked version without its marks, and adds no second version for the same findings', async () => {
    const verifier = waitingVerifier()
    const { thread, state } = threadOf(
      backfillParentIds(withSource()),
      async (prompt, options) => {
        const answer = verifier.ask(prompt, options)
        verifier.answer(FINDINGS)
        return answer
      }
    )
    await runVerification(thread, 'm4')
    expect(textOf(byId(state.stored, 'n1'))).toBe(MARKED)

    const again = await runVerification(thread, 'n1')
    expect(again).toMatchObject({ started: true, version: 'none' })
    if (!again.started) throw new Error('not started')
    // The verifier read what the model wrote, not the marks.
    expect(verifier.asked).toHaveLength(2)
    expect(verifier.asked[1][0]).toContain(`[ANSWER]\n${ANSWER}\n`)
    expect(verifier.asked[1][0]).not.toContain('(non verificato)')
    // Same findings, marks already there: the version is not written again.
    expect(again.record).toMatchObject({ outcome: 'findings', marks: 0 })
    expect(state.stored.map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'n1',
    ])
    expect(textOf(byId(state.stored, 'n1'))).toBe(MARKED)
    expect(
      verificationsOf(byId(state.stored, 'n1').metadata).map((r) => r.marks)
    ).toEqual([2, 0])
    expect(verificationsOf(byId(state.stored, 'm4').metadata)).toHaveLength(1)
    expect(state.shown).toHaveLength(1)
  })
})
