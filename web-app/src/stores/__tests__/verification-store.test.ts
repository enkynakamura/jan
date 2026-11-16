import { describe, it, expect, beforeEach } from 'vitest'
import type { VerificationRecord } from '@/lib/verifyReply'
import { isVerifyingThread, useVerification } from '../verification-store'

const record = (
  outcome: VerificationRecord['outcome']
): VerificationRecord => ({
  at: 1,
  outcome,
  seconds: 2,
  maxOutputTokens: 8192,
  truncated: false,
  toolCalls: [],
  output: '',
  reasoning: '',
  entries: [],
  marks: 0,
})
const state = () => useVerification.getState()

describe('verification store', () => {
  beforeEach(() => {
    useVerification.setState({ running: {}, records: {} })
  })

  it('knows which replies, and which threads, are being verified', () => {
    const controller = new AbortController()
    state().start('reply-1', 'thread-a', controller)
    expect(state().running['reply-1']).toMatchObject({
      threadId: 'thread-a',
      characters: 0,
    })
    expect(isVerifyingThread('thread-a')(state())).toBe(true)
    expect(isVerifyingThread('thread-b')(state())).toBe(false)

    state().finish('reply-1', controller)
    expect(state().running).toEqual({})
    expect(isVerifyingThread('thread-a')(state())).toBe(false)
  })

  it('follows the progress of a verification that is running, and only of one', () => {
    state().start('reply-1', 'thread-a', new AbortController())
    state().progress('reply-1', 1200)
    expect(state().running['reply-1'].characters).toBe(1200)

    const before = state().running
    state().progress('reply-2', 50)
    expect(state().running).toBe(before)
  })

  it('follows the runs of a series, counting the characters of each from zero', () => {
    state().start('reply-1', 'thread-a', new AbortController())
    expect(state().running['reply-1'].series).toBeUndefined()

    state().progress('reply-1', 1200)
    state().step('reply-1', 2, 5)
    expect(state().running['reply-1']).toMatchObject({
      threadId: 'thread-a',
      characters: 0,
      series: { run: 2, of: 5 },
    })
    state().progress('reply-1', 40)
    expect(state().running['reply-1']).toMatchObject({
      characters: 40,
      series: { run: 2, of: 5 },
    })

    const before = state().running
    state().step('reply-2', 1, 5)
    expect(state().running).toBe(before)
  })

  it('stops the verification of a reply, which is over at once', () => {
    const controller = new AbortController()
    const other = new AbortController()
    state().start('reply-1', 'thread-a', controller)
    state().start('reply-2', 'thread-a', other)

    state().stop('reply-1')
    expect(controller.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    expect(Object.keys(state().running)).toEqual(['reply-2'])

    // Nothing to stop: nothing happens.
    state().stop('reply-9')
    expect(Object.keys(state().running)).toEqual(['reply-2'])
  })

  it('stops the verifications of a thread and leaves the other threads alone', () => {
    const a1 = new AbortController()
    const a2 = new AbortController()
    const b = new AbortController()
    state().start('reply-1', 'thread-a', a1)
    state().start('reply-2', 'thread-a', a2)
    state().start('reply-3', 'thread-b', b)

    state().stopThread('thread-a')
    expect([a1.signal.aborted, a2.signal.aborted, b.signal.aborted]).toEqual([
      true,
      true,
      false,
    ])
    expect(Object.keys(state().running)).toEqual(['reply-3'])
    expect(isVerifyingThread('thread-a')(state())).toBe(false)

    const before = state().running
    state().stopThread('thread-c')
    expect(state().running).toBe(before)
  })

  it('keeps the last record of each reply', () => {
    state().setRecord('reply-1', record('findings'))
    state().setRecord('reply-2', record('no-findings'))
    state().setRecord('reply-1', record('stopped'))
    expect(state().records['reply-1'].outcome).toBe('stopped')
    expect(state().records['reply-2'].outcome).toBe('no-findings')
  })

  it('does not notify when finishing a verification that is not running', () => {
    const before = state()
    state().finish('reply-1', new AbortController())
    expect(state()).toBe(before)
  })

  it('keeps the next verification of a reply when the one before it ends late', () => {
    const first = new AbortController()
    const second = new AbortController()
    state().start('reply-1', 'thread-a', first)
    state().stop('reply-1')
    state().start('reply-1', 'thread-a', second)

    // The stopped one ends only now.
    const before = state()
    state().finish('reply-1', first)
    expect(state()).toBe(before)
    expect(state().running['reply-1'].controller).toBe(second)
    expect(second.signal.aborted).toBe(false)

    state().finish('reply-1', second)
    expect(state().running).toEqual({})
  })
})
