import { describe, it, expect } from 'vitest'
import {
  ChatCompletionRole,
  ContentType,
  MessageStatus,
  type ThreadMessage,
} from '@janhq/core'
import { linkToActivePath } from '../linkToActivePath'
import {
  computeActivePath,
  planContinuation,
  withActiveChild,
} from '../message-branching'

// Made-up messages: nothing here comes from a real conversation.
const message = (
  id: string,
  role: ChatCompletionRole,
  at: number,
  metadata?: Record<string, unknown>
): ThreadMessage => ({
  id,
  object: 'thread.message',
  thread_id: 't1',
  role,
  content: [{ type: ContentType.Text, text: { value: id, annotations: [] } }],
  status: MessageStatus.Ready,
  created_at: at,
  completed_at: at,
  metadata,
})
const user = ChatCompletionRole.User
const assistant = ChatCompletionRole.Assistant

// One question with two versions of the reply; the second is the one shown.
const withVersions = [
  message('q1', user, 1, { parentId: null, activeChildId: 'a1-second' }),
  message('a1', assistant, 2, { parentId: 'q1' }),
  message('a1-second', assistant, 3, { parentId: 'q1' }),
]
const shown = (messages: ThreadMessage[], activeRootId?: string) =>
  computeActivePath(messages, activeRootId).map((m) => m.id)

describe('linkToActivePath', () => {
  it('links a new message to the reply that is shown', () => {
    const next = message('q2', user, 4, { note: 'kept' })
    const linked = linkToActivePath(next, withVersions, undefined)
    expect(linked).toEqual({
      ...next,
      metadata: { note: 'kept', parentId: 'a1-second' },
    })
    expect(shown([...withVersions, linked])).toEqual(['q1', 'a1-second', 'q2'])
    // The message that was passed in is not changed.
    expect(next.metadata).toEqual({ note: 'kept' })
  })

  it('follows the version that is shown, not the last one written', () => {
    const first = [
      withActiveChild(withVersions[0], 'a1'),
      ...withVersions.slice(1),
    ]
    const linked = linkToActivePath(message('q2', user, 4), first, undefined)
    expect(linked.metadata).toEqual({ parentId: 'a1' })
    expect(shown([...first, linked])).toEqual(['q1', 'a1', 'q2'])
  })

  it('follows the first message that is shown, when the first message has versions', () => {
    const roots = [
      message('q1', user, 1, { parentId: null }),
      message('a1', assistant, 2, { parentId: 'q1' }),
      message('q1-second', user, 3, { parentId: null }),
      message('a1-of-second', assistant, 4, { parentId: 'q1-second' }),
    ]
    expect(
      linkToActivePath(message('q2', user, 5), roots, 'q1').metadata
    ).toEqual({ parentId: 'a1' })
    expect(
      linkToActivePath(message('q2', user, 5), roots, undefined).metadata
    ).toEqual({ parentId: 'a1-of-second' })
  })

  it('leaves a message as it is in a thread without versions', () => {
    const plain = [message('q1', user, 1), message('a1', assistant, 2)]
    const next = message('q2', user, 3, { note: 'kept' })
    expect(linkToActivePath(next, plain, undefined)).toBe(next)
    expect(linkToActivePath(next, [], undefined)).toBe(next)
  })

  // What goes wrong without the link, and what the link changes: the reply
  // to the new message is given a parent the way the chat screen does it
  // (the message it was sent for, or else the last user message shown).
  describe('the reply to a message sent in a thread with versions', () => {
    const parentOfReply = (
      messages: ThreadMessage[],
      sentFor: string | null
    ) => {
      const path = computeActivePath(messages)
      const lastUser = [...path].reverse().find((m) => m.role === user)
      return (
        planContinuation(messages, 'a2', null, sentFor).parentId ??
        lastUser?.id ??
        null
      )
    }
    const afterReply = (question: ThreadMessage, sentFor: string | null) => {
      const before = [...withVersions, question]
      const parentId = parentOfReply(before, sentFor)!
      const reply = message('a2', assistant, 5, { parentId })
      return before
        .map((m) => (m.id === parentId ? withActiveChild(m, 'a2') : m))
        .concat(reply)
    }

    it('without the link, the message is lost and its reply becomes a version of the reply before', () => {
      const thread = afterReply(message('q2', user, 4), null)
      expect(shown(thread)).toEqual(['q1', 'a2'])
    })

    it('with the link, the message and its reply continue the conversation', () => {
      const linked = linkToActivePath(
        message('q2', user, 4),
        withVersions,
        undefined
      )
      const thread = afterReply(linked, 'q2')
      expect(shown(thread)).toEqual(['q1', 'a1-second', 'q2', 'a2'])
    })
  })
})
