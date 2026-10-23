import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

// Fork: one transport per thread. The route component is reused across
// threads, and a thread opened after another used to get the other's
// transport: the two shared system message and thread id, so a turn going on
// in the background was sent with the instructions of the thread on screen.

const h = vi.hoisted(() => {
  class FakeTransport {
    systemMessage: string | undefined
    threadId: string | undefined
    constructor(systemMessage?: string, threadId?: string) {
      this.systemMessage = systemMessage
      this.threadId = threadId
    }
    updateSystemMessage(systemMessage?: string) {
      this.systemMessage = systemMessage
    }
    setOnTokenUsage() {}
    refreshTools() {}
    setContinueFromContent() {}
    updateRagToolsAvailability() {}
  }
  return { FakeTransport }
})

vi.mock('@/lib/custom-chat-transport', () => ({
  CustomChatTransport: h.FakeTransport,
}))
vi.mock('@/hooks/useAppState', () => {
  const state = {
    mcpToolNames: new Set<string>(),
    ragToolNames: new Set<string>(),
  }
  return {
    useAppState: (selector: (s: typeof state) => unknown) => selector(state),
  }
})

import { useChat } from '../use-chat'
import { useChatSessions } from '@/stores/chat-session-store'

type Props = { sessionId: string; systemMessage: string }
type Fake = InstanceType<typeof h.FakeTransport>
const transportOf = (id: string) =>
  useChatSessions.getState().sessions[id]?.transport as unknown as Fake

describe('useChat: one transport per thread (fork)', () => {
  beforeEach(() => {
    useChatSessions.getState().clearSessions()
  })

  it('gives a thread opened after another its own transport', () => {
    const { rerender } = renderHook((p: Props) => useChat(p), {
      initialProps: { sessionId: 'thread-a', systemMessage: 'rules A' },
    })
    rerender({ sessionId: 'thread-b', systemMessage: 'rules B' })

    const a = transportOf('thread-a')
    const b = transportOf('thread-b')
    expect(b).not.toBe(a)
    expect(b.threadId).toBe('thread-b')
    expect(b.systemMessage).toBe('rules B')
    expect(a.systemMessage).toBe('rules A')
  })

  it('goes back to the thread\'s own transport', () => {
    const { rerender } = renderHook((p: Props) => useChat(p), {
      initialProps: { sessionId: 'thread-a', systemMessage: 'rules A' },
    })
    const first = transportOf('thread-a')
    rerender({ sessionId: 'thread-b', systemMessage: 'rules B' })
    rerender({ sessionId: 'thread-a', systemMessage: 'rules A' })

    expect(transportOf('thread-a')).toBe(first)
    expect(first.systemMessage).toBe('rules A')
    expect(transportOf('thread-b').systemMessage).toBe('rules B')
  })
})
