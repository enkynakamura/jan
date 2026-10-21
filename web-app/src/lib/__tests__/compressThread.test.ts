// Fork (21/10/2026): Compress thread links the images of the original thread into the new one
// (link_thread_images, src-tauri/src/core/pasted_images.rs). Only that part is tested here: a thread with no
// reasoning block, so no call to the model.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const invoke = vi.fn()
  const toastError = vi.fn()
  const createMessage = vi.fn(async () => undefined)
  const fetchMessages = vi.fn()
  const threadsState = {
    createThread: vi.fn(async () => ({ id: 'new-thread', title: '[compressione in corso] Quadro' })),
    updateThread: vi.fn(),
    deleteThread: vi.fn(),
    threads: {} as Record<string, unknown>,
  }
  const setMessages = vi.fn()
  return { invoke, toastError, createMessage, fetchMessages, threadsState, setMessages }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
vi.mock('sonner', () => ({ toast: { error: h.toastError } }))
vi.mock('ai', () => ({ generateText: vi.fn() }))
vi.mock('@/lib/model-factory', () => ({ ModelFactory: { createModel: vi.fn() } }))
vi.mock('@/hooks/useModelProvider', () => ({ useModelProvider: { getState: vi.fn() } }))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    messages: () => ({ fetchMessages: h.fetchMessages, createMessage: h.createMessage }),
  }),
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => h.threadsState, subscribe: () => () => undefined },
}))
vi.mock('@/hooks/useMessages', () => ({
  useMessages: { getState: () => ({ setMessages: h.setMessages }) },
}))
vi.mock('@janhq/core', () => ({ ContentType: { Reasoning: 'reasoning', Text: 'text' } }))

import { CompressionCancelled, compressThreadReasoning } from '../compressThread'
import type { Thread } from '@janhq/core'

const original = {
  id: 'old-thread',
  title: 'Quadro',
  model: { id: 'qwen', provider: 'llamacpp' },
  metadata: {},
  assistants: [],
} as unknown as Thread

const message = {
  id: 'm1',
  thread_id: 'old-thread',
  role: 'user',
  content: [
    {
      type: 'text',
      text: {
        value:
          'che quadro è?\n\n[Immagine 1 salvata anche come file: /immagini/2026-10-21_101500_1.png (nella sandbox, sola lettura)]',
        annotations: [],
      },
    },
  ],
  metadata: {},
}

describe('compressThreadReasoning: pasted images (fork)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.fetchMessages.mockResolvedValue([message])
  })

  it('links the images of the original thread into the new one before copying the messages', async () => {
    h.invoke.mockResolvedValue(1)
    const { thread } = await compressThreadReasoning(original)
    expect(h.invoke).toHaveBeenCalledWith('link_thread_images', {
      fromThreadId: 'old-thread',
      toThreadId: 'new-thread',
    })
    // linked first: the original thread may be deleted while the messages are copied
    expect(h.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      h.createMessage.mock.invocationCallOrder[0]
    )
    // the copied message keeps the line that names the image
    expect(h.createMessage.mock.calls[0][0].content[0].text.value).toContain(
      '/immagini/2026-10-21_101500_1.png'
    )
    expect(thread.title).toBe('[compresso] Quadro')
    expect(h.toastError).not.toHaveBeenCalled()
  })

  it('finishes the compression and says so when the images cannot be linked', async () => {
    h.invoke.mockRejectedValue('link_thread_images: Incorrect function. (os error 1)')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { thread } = await compressThreadReasoning(original)
      expect(thread.title).toBe('[compresso] Quadro')
      expect(h.createMessage).toHaveBeenCalledTimes(1)
      expect(h.threadsState.updateThread).toHaveBeenCalledWith('new-thread', {
        title: '[compresso] Quadro',
      })
      expect(h.setMessages).toHaveBeenCalledWith('new-thread', expect.any(Array))
      expect(h.threadsState.deleteThread).not.toHaveBeenCalled()
      expect(h.toastError).toHaveBeenCalledWith(
        'The images of this thread were not linked into its compressed copy: link_thread_images: Incorrect function. (os error 1)'
      )
    } finally {
      errors.mockRestore()
    }
  })

  it('lets a stop pressed meanwhile win over a failed link', async () => {
    const stop = new AbortController()
    h.invoke.mockImplementation(async () => {
      stop.abort()
      throw 'link_thread_images: the thread folder C:\\x does not exist'
    })
    await expect(compressThreadReasoning(original, undefined, stop.signal)).rejects.toBeInstanceOf(
      CompressionCancelled
    )
    expect(h.threadsState.deleteThread).toHaveBeenCalledWith('new-thread')
    expect(h.createMessage).not.toHaveBeenCalled()
    expect(h.threadsState.updateThread).not.toHaveBeenCalled()
    expect(h.toastError).not.toHaveBeenCalled()
  })

  it('links nothing when stopped before it starts', async () => {
    const stop = new AbortController()
    stop.abort()
    await expect(compressThreadReasoning(original, undefined, stop.signal)).rejects.toBeInstanceOf(
      CompressionCancelled
    )
    expect(h.invoke).not.toHaveBeenCalled()
    expect(h.createMessage).not.toHaveBeenCalled()
    expect(h.threadsState.deleteThread).toHaveBeenCalledWith('new-thread')
  })

  it('lets a stop pressed meanwhile win over a link that succeeded', async () => {
    const stop = new AbortController()
    h.invoke.mockImplementation(async () => {
      stop.abort()
      return 1
    })
    await expect(compressThreadReasoning(original, undefined, stop.signal)).rejects.toBeInstanceOf(
      CompressionCancelled
    )
    expect(h.threadsState.deleteThread).toHaveBeenCalledWith('new-thread')
    expect(h.createMessage).not.toHaveBeenCalled()
    expect(h.threadsState.updateThread).not.toHaveBeenCalled()
    expect(h.setMessages).not.toHaveBeenCalled()
  })
})
