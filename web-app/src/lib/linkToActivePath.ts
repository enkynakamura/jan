/**
 * Where a new user message goes in a thread whose messages have versions.
 *
 * Such a thread is a tree: each message names its parent, and the
 * conversation shown is one path of the tree. A message that names no parent
 * is on no path: once the thread is opened again it is not shown, and the
 * reply to it is attached to the turn before, as one more version of that
 * turn's reply. So a new message has to be linked to the message that ends
 * the conversation as it is shown. A thread without versions is a plain list
 * and needs no link.
 */
import type { ThreadMessage } from '@janhq/core'
import {
  computeActivePath,
  hasBranching,
  withParentId,
} from '@/lib/message-branching'

/**
 * `message` linked to the end of the conversation shown. `messages` are the
 * messages the thread has before it. In a thread without versions `message`
 * is returned as it is.
 */
export function linkToActivePath(
  message: ThreadMessage,
  messages: ThreadMessage[],
  activeRootId: string | undefined
): ThreadMessage {
  if (!hasBranching(messages)) return message
  const path = computeActivePath(messages, activeRootId)
  return withParentId(message, path[path.length - 1].id)
}
