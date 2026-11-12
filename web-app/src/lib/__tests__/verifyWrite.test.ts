import { describe, it, expect } from 'vitest'
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
  withActiveChild,
} from '../message-branching'
import type { VerificationRecord } from '../verifyReply'
import {
  markedVersion,
  pathToVerify,
  verificationsOf,
  withVerification,
} from '../verifyWrite'

// A made-up thread: nothing here comes from a real conversation.
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
const call = {
  type: ContentType.ToolCall,
  tool_call_id: 'c1',
  tool_name: 'web_fetch',
  input: { url: 'https://example.org/alda' },
  output: 'Opened to traffic in 1934.',
} as ThreadContent

const record = (
  outcome: VerificationRecord['outcome'],
  at = 1
): VerificationRecord => ({
  at,
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

// q1 -> a2 -> q3 -> a4, linked as a thread is once it has versions.
const linear = [
  message('m1', ChatCompletionRole.User, [text('first question')]),
  message('m2', ChatCompletionRole.Assistant, [text('first answer')]),
  message('m3', ChatCompletionRole.User, [text('When did it open?')]),
  message(
    'm4',
    ChatCompletionRole.Assistant,
    [reasoning, call, text('It opened in 1932.')],
    { usage: { outputTokens: 12 }, toolErrors: { c9: 'denied' } }
  ),
]
const thread = backfillParentIds(linear)
const reply = thread[3]

describe('verificationsOf and withVerification', () => {
  it('reads no records from a reply that was never verified', () => {
    expect(verificationsOf(undefined)).toEqual([])
    expect(verificationsOf({})).toEqual([])
    expect(verificationsOf(reply.metadata)).toEqual([])
  })

  it('adds each record after the ones already there, and changes nothing else', () => {
    const once = withVerification(reply, record('no-findings', 1))
    const twice = withVerification(once, record('findings', 2))
    expect(verificationsOf(twice.metadata)).toEqual([
      record('no-findings', 1),
      record('findings', 2),
    ])
    expect(twice).toEqual({
      ...reply,
      metadata: {
        ...reply.metadata,
        verifications: verificationsOf(twice.metadata),
      },
    })
    // The reply that was passed in is not changed.
    expect(verificationsOf(reply.metadata)).toEqual([])
    expect(verificationsOf(once.metadata)).toHaveLength(1)
  })
})

describe('markedVersion', () => {
  const verified = withVerification(reply, record('findings'))
  const marked = [
    reasoning,
    call,
    text('It opened in 1932 (contraddetto dalla fonte).'),
  ]
  const version = markedVersion(verified, marked, 'm5', 500)

  it('is a new message with the marked content, beside the reply', () => {
    expect(version.id).toBe('m5')
    expect(version.created_at).toBe(500)
    expect(version.content).toBe(marked)
    expect(version.role).toBe(ChatCompletionRole.Assistant)
    expect(version.thread_id).toBe('t1')
    // Same parent: the two are versions of the same reply.
    expect(version.metadata?.parentId).toBe('m3')
    expect(verified.metadata?.parentId).toBe('m3')
  })

  it('keeps the reasoning and the tool call, with its result', () => {
    expect(version.content[0]).toEqual(reasoning)
    expect(version.content[1]).toEqual(call)
  })

  it('says which reply it marks, and carries its records and its metadata', () => {
    expect(version.metadata).toEqual({
      ...verified.metadata,
      verifiedFrom: 'm4',
    })
    expect(verificationsOf(version.metadata)).toEqual([record('findings')])
    expect(version.metadata?.toolErrors).toEqual({ c9: 'denied' })
  })

  it('starts ready, with no error and no children of its own', () => {
    const failed: ThreadMessage = {
      ...verified,
      status: MessageStatus.Error,
      metadata: { ...verified.metadata, error: 'cut off', activeChildId: 'm7' },
    }
    const fresh = markedVersion(failed, marked, 'm6', 600)
    expect(fresh.status).toBe(MessageStatus.Ready)
    expect(fresh.completed_at).toBe(600)
    expect(fresh.metadata).toEqual({
      ...verified.metadata,
      verifiedFrom: 'm4',
    })
  })

  it('leaves the reply as it was', () => {
    expect(verified.content).toEqual([
      reasoning,
      call,
      text('It opened in 1932.'),
    ])
    expect(verified.metadata?.verifiedFrom).toBeUndefined()
  })

  it('shows as version 2 of 2, and becomes the last turn once it is made active', () => {
    const question = thread[2]
    const after = [
      thread[0],
      thread[1],
      withActiveChild(question, version.id),
      verified,
      version,
    ]
    expect(getVersionInfo(after, version)).toEqual({ index: 2, count: 2 })
    expect(getVersionInfo(after, verified)).toEqual({ index: 1, count: 2 })
    expect(computeActivePath(after).map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm5',
    ])
    // The marked version is now the one that can be verified.
    expect(pathToVerify(after, undefined, 'm5')?.map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm5',
    ])
    expect(pathToVerify(after, undefined, 'm5')?.[3]).toBe(version)
    expect(pathToVerify(after, undefined, 'm4')).toBeUndefined()
  })
})

describe('pathToVerify', () => {
  it('is the whole conversation, when the reply asked for ends it', () => {
    expect(pathToVerify(thread, undefined, 'm4')).toEqual(thread)
  })

  it('is the last turn of a thread that never had versions too', () => {
    expect(pathToVerify(linear, undefined, 'm4')).toEqual(linear)
  })

  it('follows the version that is shown, not the last one that was written', () => {
    const other = message(
      'm5',
      ChatCompletionRole.Assistant,
      [text('In 1934.')],
      {
        parentId: 'm3',
      }
    )
    const shown = (id: string) => [
      thread[0],
      thread[1],
      withActiveChild(thread[2], id),
      thread[3],
      other,
    ]
    const ids = (path: ThreadMessage[] | undefined) => path?.map((m) => m.id)
    expect(ids(pathToVerify(shown('m4'), undefined, 'm4'))).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ])
    expect(pathToVerify(shown('m4'), undefined, 'm5')).toBeUndefined()
    expect(ids(pathToVerify(shown('m5'), undefined, 'm5'))).toEqual([
      'm1',
      'm2',
      'm3',
      'm5',
    ])
    expect(pathToVerify(shown('m5'), undefined, 'm4')).toBeUndefined()
  })

  it('is nothing for a reply further up, or for a message that is not there', () => {
    expect(pathToVerify(thread, undefined, 'm2')).toBeUndefined()
    expect(pathToVerify(thread, undefined, 'm9')).toBeUndefined()
  })

  it('is nothing for a reply that no request of the user comes before', () => {
    const alone = message('m1', ChatCompletionRole.Assistant, [text('Hello.')])
    expect(pathToVerify([alone], undefined, 'm1')).toBeUndefined()
  })

  it('is nothing once the user has written after the reply', () => {
    const next = message('m5', ChatCompletionRole.User, [text('And then?')], {
      parentId: 'm4',
    })
    expect(pathToVerify([...thread, next], undefined, 'm4')).toBeUndefined()
  })
})
