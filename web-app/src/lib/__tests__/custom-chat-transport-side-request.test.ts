import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import type * as ProviderCaps from '@/lib/providerCaps'
import type { SideRequest, SideRequestResult } from '@/lib/sideRequest'

// A request outside the conversation has to start with the prompt of the
// thread's turns: the same system message and the same tools, sent with the
// same parameters. The scaffolding is the one of
// custom-chat-transport-prefix-stability.test.ts: every streamText({...}) of a
// turn is captured, and so is every side request.
const streamTextCalls: Array<Record<string, unknown>> = []

const h = vi.hoisted(() => ({
  disabledTools: [] as string[],
  servers: ['srv'] as string[],
  getRelevantTools: vi.fn(),
  getModelProps: vi.fn(),
  assistantParameters: null as Record<string, unknown> | null,
  providerId: 'openai',
  serviceHub: null as unknown,
  predefinedRemote: false,
  runSideRequest: vi.fn(),
}))

const mcpService = {
  getTools: vi.fn(async () => []),
  getToolsForServers: vi.fn(async () => []),
  getServerSummaries: vi.fn(async () =>
    h.servers.map((name) => ({ name, capabilities: [], description: '' }))
  ),
}

h.serviceHub = {
  mcp: () => mcpService,
  rag: () => ({ getTools: async () => [] }),
}

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    streamText: (args: Record<string, unknown>) => {
      streamTextCalls.push(args)
      return {
        toUIMessageStream: () =>
          new ReadableStream({
            start(controller) {
              controller.close()
            },
          }),
      }
    },
  }
})

const provider = {
  provider: 'openai',
  active: true,
  api_key: 'k',
  models: [{ id: 'gpt', capabilities: ['tools'] }],
  settings: [] as Array<{ key: string; controller_props: { value: boolean } }>,
}
const selectedModel = { id: 'gpt', capabilities: ['tools'] }

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: h.serviceHub }) },
}))
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: {
    getState: () => ({ getDisabledTools: () => h.disabledTools }),
  },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      selectedModel,
      selectedProvider: h.providerId,
      getProviderByName: () => provider,
    }),
  },
}))
vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: {
    getState: () => ({
      currentAssistant: h.assistantParameters
        ? { parameters: h.assistantParameters }
        : null,
    }),
  },
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ threads: {} }) },
}))
vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: { getState: () => ({ enabled: false }) },
}))
vi.mock('@/hooks/useMCPServers', () => ({
  useMCPServers: {
    getState: () => ({ settings: { enableSmartToolRouting: true } }),
  },
}))
// Every getState() setter is a no-op; unknown reads (currentStreamThreadId)
// resolve to undefined.
vi.mock('@/hooks/useAppState', () => ({
  useAppState: {
    getState: () =>
      new Proxy(
        {},
        {
          get: () => () => undefined,
        }
      ),
  },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))
vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  getLoadedModels: vi.fn(async () => ['llama-local']),
  unloadLlamaModel: vi.fn(),
}))
vi.mock('@/lib/llamacppRouterProps', () => ({
  getLlamacppExtension: () => ({ getModelProps: h.getModelProps }),
}))
vi.mock('@/lib/mcp-orchestrator', () => ({
  mcpOrchestrator: { getRelevantTools: h.getRelevantTools },
}))
vi.mock('@/lib/mcp-router-model-filter', () => ({
  isRouterModelSelectable: () => false,
}))
vi.mock('@/lib/reasoningProviderOptions', () => ({
  buildReasoningProviderOptions: () => undefined,
}))
vi.mock('@/lib/providerCaps', async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderCaps>()),
  isPredefinedRemoteProvider: () => h.predefinedRemote,
  getProviderApiType: () => 'openai',
}))
vi.mock('../model-factory', () => ({
  ModelFactory: { createModel: vi.fn(async () => ({ modelId: 'gpt' })) },
}))
vi.mock('@/lib/sideRequest', () => ({ runSideRequest: h.runSideRequest }))

import { CustomChatTransport } from '../custom-chat-transport'
import { ModelFactory } from '../model-factory'

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage
const assistant = (id: string, text: string): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }] }) as UIMessage

async function drain(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
}

const send = (transport: CustomChatTransport, messages: UIMessage[]) =>
  transport.sendMessages({
    chatId: 'thread-1',
    messages,
    abortSignal: undefined,
    trigger: 'submit-message',
    messageId: undefined,
  })

const answer: SideRequestResult = {
  text: 'NO FINDINGS',
  reasoning: 'checked',
  finishReason: 'stop',
  inputTokens: 900,
  outputTokens: 40,
  toolCalls: [],
  servedModel: 'the-model-loaded',
}
/** What the transport handed to `runSideRequest` at its nth call. */
const sideRequestSent = (n = 0) =>
  h.runSideRequest.mock.calls[n][0] as SideRequest
/** The parameters the nth model was created with. */
const modelParameters = (n: number) =>
  vi.mocked(ModelFactory.createModel).mock.calls[n][2]

describe('CustomChatTransport.sideRequest', () => {
  beforeEach(() => {
    streamTextCalls.length = 0
    h.disabledTools = []
    h.servers = ['srv']
    h.providerId = 'openai'
    h.predefinedRemote = false
    h.assistantParameters = null
    h.getModelProps.mockReset()
    provider.provider = 'openai'
    provider.settings = []
    selectedModel.id = 'gpt'
    selectedModel.capabilities = ['tools']
    h.getRelevantTools.mockReset()
    h.getRelevantTools.mockResolvedValue([
      {
        name: 'tool_a',
        description: 'a',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
        server: 'srv',
      },
    ])
    h.runSideRequest.mockReset()
    h.runSideRequest.mockResolvedValue(answer)
    vi.mocked(ModelFactory.createModel).mockClear()
  })

  it('sends the system message and the tools of a turn of the thread', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(await send(transport, [user('u1', 'hello')]))
    await transport.sideRequest('Check this turn.', { maxOutputTokens: 8192 })

    expect(streamTextCalls).toHaveLength(1)
    expect(h.runSideRequest).toHaveBeenCalledTimes(1)
    const turn = streamTextCalls[0]
    const side = sideRequestSent()

    expect(typeof turn.system).toBe('string')
    expect(side.system).toBe(turn.system)
    // Whatever a turn offers (web search is on by default), and tool_a in it.
    expect(Object.keys(side.tools as object)).toContain('tool_a')
    expect(Object.keys(side.tools as object)).toEqual(
      Object.keys(turn.tools as object)
    )
    expect(side.tools).toEqual(turn.tools)
    expect(JSON.stringify(side.tools)).toBe(JSON.stringify(turn.tools))
    expect(side.maxRetries).toBe(turn.maxRetries)
  })

  it('sends them again unchanged after a second turn', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    const turn1 = [user('u1', 'hello')]
    await drain(await send(transport, turn1))
    await transport.sideRequest('Check this turn.', { maxOutputTokens: 8192 })
    await drain(
      await send(transport, [
        ...turn1,
        assistant('a1', 'hi there'),
        user('u2', 'again'),
      ])
    )

    // The turn after the side request still starts as the one before it.
    const [before, after] = streamTextCalls
    expect(after.system).toBe(before.system)
    expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools))
    expect(sideRequestSent().system).toBe(after.system)
  })

  it('passes the prompt, the cap, the stop signal and the progress callback', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    const controller = new AbortController()
    const onProgress = vi.fn()
    await transport.sideRequest('Check this turn.', {
      maxOutputTokens: 8192,
      abortSignal: controller.signal,
      onProgress,
    })

    const side = sideRequestSent()
    expect(side.prompt).toBe('Check this turn.')
    expect(side.maxOutputTokens).toBe(8192)
    expect(side.abortSignal).toBe(controller.signal)
    expect(side.onProgress).toBe(onProgress)
  })

  it('creates the model with the parameters of a turn, without its output cap', async () => {
    h.assistantParameters = {
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 4096,
      max_tokens: 2048,
    }
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(await send(transport, [user('u1', 'hello')]))
    await transport.sideRequest('Check this turn.', { maxOutputTokens: 8192 })

    expect(vi.mocked(ModelFactory.createModel)).toHaveBeenCalledTimes(2)
    expect(modelParameters(0)).toEqual({
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 4096,
      max_tokens: 2048,
    })
    // The cap of the assistant would replace the one asked for here.
    expect(modelParameters(1)).toEqual({ temperature: 0.7, top_p: 0.9 })
    expect(sideRequestSent().maxOutputTokens).toBe(8192)
  })

  it('returns the answer and the model that gave it', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    expect(
      await transport.sideRequest('Check this turn.', { maxOutputTokens: 8192 })
    ).toEqual({ ...answer, model: { provider: 'openai', id: 'gpt' } })
  })

  it('asks the model selected when it is made, not the one of the last turn', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(await send(transport, [user('u1', 'hello')]))
    // The reply is there; the user selects another model, of another
    // provider, to have it checked.
    h.providerId = 'checker-provider'
    selectedModel.id = 'checker'

    const result = await transport.sideRequest('Check this turn.', {
      maxOutputTokens: 8192,
    })
    expect(result.model).toEqual({ provider: 'checker-provider', id: 'checker' })
  })

  it('offers no tools when the model cannot use them, as a turn does', async () => {
    selectedModel.capabilities = []
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(await send(transport, [user('u1', 'hello')]))
    await transport.sideRequest('Check this turn.', { maxOutputTokens: 8192 })

    expect(streamTextCalls[0].tools).toBeUndefined()
    expect(sideRequestSent().tools).toBeUndefined()
  })

  it('leaves the turn in progress alone', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(await send(transport, [user('u1', 'hello')]))
    const modelOfTheTurn = transport.model
    transport.setContinueFromContent('Roses are red,')

    await transport.sideRequest('Check this turn.', { maxOutputTokens: 8192 })

    // The model of the turn is still the transport's, and the partial reply
    // waiting to be continued was not used up by the side request.
    expect(transport.model).toBe(modelOfTheTurn)
    streamTextCalls.length = 0
    await drain(
      await send(transport, [
        user('u1', 'write a poem'),
        assistant('a1', 'here goes'),
        user('u2', 'continue'),
      ])
    )
    const messages = streamTextCalls[0].messages as Array<{
      role: string
      content: unknown
    }>
    expect(messages[messages.length - 1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Roses are red,' }],
    })
  })

  it('rejects with the error of the request', async () => {
    h.runSideRequest.mockRejectedValue(new Error('engine crashed'))
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await expect(
      transport.sideRequest('Check this turn.', { maxOutputTokens: 8192 })
    ).rejects.toThrow('engine crashed')
  })
})
