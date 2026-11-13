import { describe, it, expect } from 'vitest'
import { jsonSchema, type Tool } from 'ai'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { runSideRequest, type SideRequest } from '../sideRequest'

// The real SDK with a model that replays a fixed stream.
const usage = {
  inputTokens: {
    total: 100,
    noCache: 100,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 42, text: 30, reasoning: 12 },
}
const finish = (reason: 'stop' | 'length' | 'tool-calls') => ({
  type: 'finish' as const,
  finishReason: { unified: reason, raw: reason },
  usage,
})
const answer = [
  { type: 'stream-start' as const, warnings: [] },
  { type: 'reasoning-start' as const, id: 'r' },
  { type: 'reasoning-delta' as const, id: 'r', delta: 'checking' },
  { type: 'reasoning-end' as const, id: 'r' },
  { type: 'text-start' as const, id: 't' },
  { type: 'text-delta' as const, id: 't', delta: 'NO ' },
  { type: 'text-delta' as const, id: 't', delta: 'FINDINGS' },
  { type: 'text-end' as const, id: 't' },
]
const replay = (chunks: LanguageModelV3StreamPart[], chunkDelayInMs = 0) =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunkDelayInMs, chunks }),
    }),
  })

const tools: Record<string, Tool> = {
  web_search: {
    description: 'Search the web',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { query: { type: 'string' } },
    }),
  } as Tool,
}
const request = (
  model: MockLanguageModelV3,
  more: Partial<SideRequest> = {}
): SideRequest => ({
  model,
  system: 'The rules of the thread.',
  tools,
  prompt: 'Check this turn.',
  maxOutputTokens: 8192,
  maxRetries: 0,
  ...more,
})

describe('runSideRequest', () => {
  it('sends the system message, the tools, one user message and the cap', async () => {
    const model = replay([...answer, finish('stop')])
    await runSideRequest(request(model))

    expect(model.doStreamCalls).toHaveLength(1)
    const sent = model.doStreamCalls[0]
    expect(sent.prompt).toEqual([
      { role: 'system', content: 'The rules of the thread.' },
      { role: 'user', content: [{ type: 'text', text: 'Check this turn.' }] },
    ])
    expect(sent.tools).toEqual([
      {
        type: 'function',
        name: 'web_search',
        description: 'Search the web',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    ])
    expect(sent.toolChoice).toEqual({ type: 'auto' })
    expect(sent.maxOutputTokens).toBe(8192)
  })

  it('offers no tools and no tool choice when it is given none', async () => {
    const model = replay([...answer, finish('stop')])
    await runSideRequest(
      request(model, { tools: undefined, system: undefined })
    )

    const sent = model.doStreamCalls[0]
    expect(sent.tools).toBeUndefined()
    expect(sent.toolChoice).toBeUndefined()
    expect(sent.prompt).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Check this turn.' }] },
    ])
  })

  it('returns the whole answer, apart from the reasoning, and the usage', async () => {
    expect(
      await runSideRequest(request(replay([...answer, finish('stop')])))
    ).toEqual({
      text: 'NO FINDINGS',
      reasoning: 'checking',
      finishReason: 'stop',
      inputTokens: 100,
      outputTokens: 42,
      toolCalls: [],
      toolInputs: [],
      // The answer names no model: the one that was asked.
      servedModel: 'mock-model-id',
    })
  })

  it('reports the model the answer says it came from, not the one that was asked', async () => {
    const result = await runSideRequest(
      request(
        replay([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'response-metadata' as const, modelId: 'the-model-loaded' },
          ...answer.slice(1),
          finish('stop'),
        ])
      )
    )
    expect(result.servedModel).toBe('the-model-loaded')
    expect(result.text).toBe('NO FINDINGS')
  })

  it('says when the cap cut the answer', async () => {
    const result = await runSideRequest(
      request(replay([...answer, finish('length')]))
    )
    expect(result.finishReason).toBe('length')
    expect(result.text).toBe('NO FINDINGS')
  })

  it('reports a tool the model called instead of answering, without running it', async () => {
    const model = replay([
      { type: 'stream-start' as const, warnings: [] },
      {
        type: 'tool-call' as const,
        toolCallId: 'c1',
        toolName: 'web_search',
        input: '{"query":"alda bridge"}',
      },
      finish('tool-calls'),
    ])
    expect(await runSideRequest(request(model))).toMatchObject({
      text: '',
      reasoning: '',
      finishReason: 'tool-calls',
      toolCalls: ['web_search'],
      // What the model wanted the tool to do is kept, to be shown.
      toolInputs: ['{"query":"alda bridge"}'],
    })
    // One request only: no result was made up for the call and sent back.
    expect(model.doStreamCalls).toHaveLength(1)
  })

  it('follows the answer as it arrives', async () => {
    const seen: number[] = []
    await runSideRequest(
      request(replay([...answer, finish('stop')]), {
        onProgress: (characters) => seen.push(characters),
      })
    )
    // "checking", then "NO ", then "FINDINGS".
    expect(seen).toEqual([8, 11, 19])
  })

  it('rejects with the error of a request that fails before it answers', async () => {
    const down = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error('connection refused')
      },
    })
    await expect(runSideRequest(request(down))).rejects.toThrow(
      'connection refused'
    )
  })

  it('rejects with the error of a request that fails while it answers', async () => {
    const broken = replay([
      ...answer.slice(0, 6),
      { type: 'error' as const, error: new Error('engine crashed') },
    ])
    await expect(runSideRequest(request(broken))).rejects.toThrow(
      'engine crashed'
    )
  })

  it('rejects with an AbortError when it is stopped', async () => {
    const slow = replay(
      [
        ...answer.slice(0, 5),
        ...Array.from({ length: 200 }, () => ({
          type: 'text-delta' as const,
          id: 't',
          delta: 'x',
        })),
        { type: 'text-end' as const, id: 't' },
        finish('stop'),
      ],
      5
    )
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)
    await expect(
      runSideRequest(request(slow, { abortSignal: controller.signal }))
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
