import { describe, it, expect } from 'vitest'
import { Chat, type UIMessage } from '@ai-sdk/react'
import {
  convertToModelMessages,
  streamText,
  type ChatTransport,
  type UIMessageChunk,
} from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { guardRepetition, type RepetitionStop } from '../repetitionGuard'

// The real SDK, not a mocked chat: a model whose reasoning repeats one word
// 1000 times, sent through the guard the way the transport does it. The turn
// has to end as a Stop does (`isAbort`), with the mark on the message.
const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

function loopingModel() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: 1,
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'reasoning-start' as const, id: 'r1' },
          ...Array.from({ length: 1000 }, () => ({
            type: 'reasoning-delta' as const,
            id: 'r1',
            delta: "'Rally ",
          })),
          { type: 'reasoning-end' as const, id: 'r1' },
          { type: 'text-start' as const, id: 't1' },
          { type: 'text-delta' as const, id: 't1', delta: 'done' },
          { type: 'text-end' as const, id: 't1' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage,
          },
        ],
      }),
    }),
  })
}

describe('repetitionGuard with the SDK chat', () => {
  it('ends a looping turn as a Stop and leaves the mark on the message', async () => {
    const model = loopingModel()
    const trips: RepetitionStop[] = []
    // eslint-disable-next-line prefer-const
    let chat: Chat<UIMessage>
    const transport: ChatTransport<UIMessage> = {
      async sendMessages({ messages, abortSignal }) {
        const result = streamText({
          model,
          messages: await convertToModelMessages(messages),
          abortSignal,
        })
        return guardRepetition(
          result.toUIMessageStream() as ReadableStream<UIMessageChunk>,
          (stop) => {
            trips.push(stop)
            setTimeout(() => chat.stop(), 0)
          }
        )
      },
      async reconnectToStream() {
        return null
      },
    }
    const finished = new Promise<{
      message: UIMessage
      isAbort: boolean
      isError: boolean
    }>((resolve) => {
      chat = new Chat<UIMessage>({ transport, onFinish: (e) => resolve(e) })
    })

    await chat!.sendMessage({ text: 'hi' })
    const { message, isAbort, isError } = await finished

    expect(trips).toHaveLength(1)
    expect(isAbort).toBe(true)
    expect(isError).toBe(false)
    expect(message.metadata).toEqual({ repetitionStop: trips[0] })
    expect(trips[0].words).toBe(200)

    const reasoning = message.parts
      .filter((p) => p.type === 'reasoning')
      .map((p) => (p as { text: string }).text)
      .join('')
    const words = reasoning.trim().split(/\s+/).length
    // Stopped soon after the 200th word, far from the 1000 the model would send.
    expect(words).toBeGreaterThanOrEqual(200)
    expect(words).toBeLessThan(400)
    expect(message.parts.some((p) => p.type === 'text')).toBe(false)
  })
})
