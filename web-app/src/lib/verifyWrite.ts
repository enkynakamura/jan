/**
 * Where a verification leaves its results in a thread: the record in the
 * metadata of the reply that was verified, and the marks in a new version of
 * the reply beside it. The reply itself is never changed.
 */
import type { ThreadContent, ThreadMessage } from '@janhq/core'
import { computeActivePath, makeSibling } from '@/lib/message-branching'
import type { VerificationRecord } from '@/lib/verifyReply'
import { lastTurn } from '@/lib/verifyTurn'

/** The records of the verifications of a reply, oldest first. */
export function verificationsOf(
  metadata: Record<string, unknown> | undefined
): VerificationRecord[] {
  const kept = metadata?.verifications
  return Array.isArray(kept) ? (kept as VerificationRecord[]) : []
}

/** `reply` with `record` added to the records in its metadata. */
export function withVerification(
  reply: ThreadMessage,
  record: VerificationRecord
): ThreadMessage {
  return {
    ...reply,
    metadata: {
      ...reply.metadata,
      verifications: [...verificationsOf(reply.metadata), record],
    },
  }
}

/**
 * A new version of `reply` beside it, with the marked content. It keeps the
 * reasoning and the tool calls of the reply, with their results, and says in
 * `verifiedFrom` which reply it marks. `reply` must already be linked to its
 * parent (see `backfillParentIds`), or the version would start a conversation
 * of its own.
 */
export function markedVersion(
  reply: ThreadMessage,
  markedContent: ThreadContent[],
  id: string,
  createdAt: number
): ThreadMessage {
  const version = makeSibling(reply, { id, createdAt })
  return {
    ...version,
    content: markedContent,
    metadata: { ...version.metadata, verifiedFrom: reply.id },
  }
}

/**
 * The conversation to verify: the one that is shown, in order, when it ends
 * with the reply `replyId` to a request of the user. A reply further up
 * cannot be given a new version without hiding the turns that follow it.
 */
export function pathToVerify(
  messages: ThreadMessage[],
  activeRootId: string | undefined,
  replyId: string
): ThreadMessage[] | undefined {
  const path = computeActivePath(messages, activeRootId)
  return lastTurn(path)?.reply.id === replyId ? path : undefined
}
