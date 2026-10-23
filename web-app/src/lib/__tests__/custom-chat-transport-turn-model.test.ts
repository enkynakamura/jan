import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import type * as ProviderCaps from '@/lib/providerCaps'

// Fork: a turn keeps the model it started with. The model selection is global
// (it follows the thread on screen): a turn going on while the user looked at
// another thread sent its tool follow-ups to that thread's model, and offered
// tools according to that model.

const h = vi.hoisted(() => {
  const strata = {
    provider: 'strata',
    active: true,
    api_key: '',
    models: [
      { id: 'qwen-q4', capabilities: ['tools'] },
      { id: 'qwen-iq4', capabilities: [] as string[] },
    ],
  }
  return {
    strata,
    selection: {
      selectedProvider: 'strata',
      selectedModel: strata.models[0] as { id: string; capabilities: string[] },
    },
    serviceHub: {
      mcp: () => ({
        getTools: async () => [
          {
            name: 'run_python_code',
            description: 'run code',
            inputSchema: { type: 'object', properties: {} },
            server: 'sandbox',
          },
        ],
      }),
      rag: () => ({ getTools: async () => [] }),
    },
    createModelMock: vi.fn(async (modelId: string) => ({ modelId })),
    streamArgs: [] as Array<Record<string, unknown>>,
  }
})

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: h.serviceHub }) },
}))
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: {
    getState: () => ({
      getDisabledTools: () => [],
      getDefaultDisabledTools: () => [],
    }),
  },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      ...h.selection,
      getProviderByName: (name: string) =>
        name === h.strata.provider ? h.strata : undefined,
    }),
  },
}))
vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: { getState: () => ({ currentAssistant: null }) },
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ threads: {} }) },
}))
vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: { getState: () => ({ enabled: false }) },
}))
vi.mock('@/hooks/useMCPServers', () => ({
  useMCPServers: { getState: () => ({ settings: {} }) },
}))
// Every getState() setter is a no-op; unknown reads resolve to undefined.
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
vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  getLoadedModels: vi.fn(async () => []),
  unloadLlamaModel: vi.fn(async () => ({ success: true })),
}))
vi.mock('@/lib/extension', () => ({
  ExtensionManager: { getInstance: () => ({ get: () => null }) },
}))
vi.mock('@/lib/mcp-orchestrator', () => ({
  mcpOrchestrator: { getRelevantTools: vi.fn() },
}))
vi.mock('@/lib/mcp-router-model-filter', () => ({
  isRouterModelSelectable: () => false,
}))
vi.mock('@/lib/reasoningProviderOptions', () => ({
  buildReasoningProviderOptions: () => undefined,
}))
vi.mock('@/lib/providerCaps', async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderCaps>()),
  isPredefinedRemoteProvider: () => false,
  getProviderApiType: () => 'openai',
}))
vi.mock('../model-factory', () => ({
  ModelFactory: { createModel: h.createModelMock },
}))
// Records what each request would send to the model
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    streamText: (args: Record<string, unknown>) => {
      h.streamArgs.push(args)
      return {
        toUIMessageStream: () => new ReadableStream({ start: (c) => c.close() }),
      }
    },
  }
})

import { CustomChatTransport } from '../custom-chat-transport'

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage
const assistant = (id: string, text: string): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }] }) as UIMessage

// As the AI SDK sends them: a user message, or the auto-resubmit after the
// tool results, with the assistant message last
const send = (transport: CustomChatTransport, messages: UIMessage[]) =>
  transport.sendMessages({
    chatId: 'thread-a',
    messages,
    abortSignal: undefined,
    trigger: 'submit-message',
    messageId: messages[messages.length - 1].id,
  })

// The thread on screen sets the global selection
const onScreen = (id: string) => {
  h.selection.selectedModel = h.strata.models.find((m) => m.id === id)!
}
const modelsSentTo = () => h.createModelMock.mock.calls.map((c) => c[0])
const toolsOffered = (request: number) =>
  Object.keys((h.streamArgs[request].tools as object | undefined) ?? {})

describe('CustomChatTransport: a turn keeps its model (fork)', () => {
  beforeEach(() => {
    h.createModelMock.mockClear()
    h.streamArgs.length = 0
    onScreen('qwen-q4')
  })

  it('sends the tool follow-up to the turn model after another thread is opened', async () => {
    const transport = new CustomChatTransport('rules A', 'thread-a')
    await send(transport, [user('u1', 'run it')])
    onScreen('qwen-iq4')
    await send(transport, [user('u1', 'run it'), assistant('a1', 'done')])

    expect(modelsSentTo()).toEqual(['qwen-q4', 'qwen-q4'])
  })

  it('keeps offering the tools of the turn model', async () => {
    const transport = new CustomChatTransport('rules A', 'thread-a')
    await send(transport, [user('u1', 'run it')])
    onScreen('qwen-iq4')
    await send(transport, [user('u1', 'run it'), assistant('a1', 'done')])

    expect(toolsOffered(1)).toContain('run_python_code')
  })

  it('starts a new turn on the model selected when the user writes', async () => {
    const transport = new CustomChatTransport('rules A', 'thread-a')
    await send(transport, [user('u1', 'run it')])
    onScreen('qwen-iq4')
    await send(transport, [
      user('u1', 'run it'),
      assistant('a1', 'done'),
      user('u2', 'again'),
    ])

    expect(modelsSentTo()).toEqual(['qwen-q4', 'qwen-iq4'])
  })

  it('reports the turn model to the thread page', async () => {
    const transport = new CustomChatTransport('rules A', 'thread-a')
    expect(transport.getTurnModelSelection().selectedModel?.id).toBe('qwen-q4')
    await send(transport, [user('u1', 'run it')])
    onScreen('qwen-iq4')

    expect(transport.getTurnModelSelection().selectedModel?.id).toBe('qwen-q4')
  })
})
