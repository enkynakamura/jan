/**
 * One click on Verify, from the request to what it leaves in the thread: the
 * record in the reply that was verified and, when statements were marked, a
 * new version of the reply beside it, which becomes the one shown.
 *
 * A verification takes minutes, and the conversation can change under it. So
 * nothing read before the request is trusted after it: the reply is read
 * again from the thread, and the new version is written only if the reply is
 * still the last one shown and no turn is running.
 */
import type { ThreadMessage } from '@janhq/core'
import {
  backfillParentIds,
  getParentId,
  hasBranching,
  withActiveChild,
} from '@/lib/message-branching'
import {
  verifyReply,
  type AskVerifier,
  type VerificationRecord,
} from '@/lib/verifyReply'
import {
  markedVersion,
  pathToVerify,
  withVerification,
} from '@/lib/verifyWrite'
import { useVerification } from '@/stores/verification-store'

/** The thread a verification runs in, as the code that owns it sees it. */
export type VerificationThread = {
  id: string
  /** The thread's messages as they are stored now; none once it is deleted. */
  messages: () => ThreadMessage[]
  /** The first message shown, when the first message has versions. */
  activeRootId: () => string | undefined
  /** Whether a turn of the thread is being written or is running its tools. */
  busy: () => boolean
  ask: AskVerifier
  /** The output cap of the verifier: the setting, as it is at the click. */
  maxOutputTokens: number
  updateMessage: (message: ThreadMessage) => void
  addMessage: (message: ThreadMessage) => void
  /** Puts on screen the conversation as it is stored now. */
  show: () => void
  newId: () => string
}

export type VerificationRun =
  /** Nothing was asked: the reply is not the last one shown, a turn is
   * running, or the reply is already being verified. */
  | { started: false }
  | {
      started: true
      record: VerificationRecord
      /**
       * `shown`: a version with the marks was written and is on screen.
       * `none`: there was nothing to mark.
       * `skipped`: there were marks to write, and the conversation had moved
       * on: the findings are in the record, the reply is as it was.
       */
      version: 'shown' | 'none' | 'skipped'
    }

/** How often, at most, the count of characters written so far is refreshed. */
const PROGRESS_EVERY_MS = 250

export async function runVerification(
  thread: VerificationThread,
  replyId: string,
  now: () => number = Date.now
): Promise<VerificationRun> {
  const path = pathToVerify(thread.messages(), thread.activeRootId(), replyId)
  if (!path || thread.busy() || useVerification.getState().running[replyId]) {
    return { started: false }
  }

  const controller = new AbortController()
  useVerification.getState().start(replyId, thread.id, controller)
  let refreshed = -Infinity
  let verification: Awaited<ReturnType<typeof verifyReply>>
  try {
    verification = await verifyReply(path, thread.ask, {
      maxOutputTokens: thread.maxOutputTokens,
      abortSignal: controller.signal,
      onProgress: (characters) => {
        // Text can still arrive after a stop, when the count on screen may
        // already be the one of the next verification of this reply.
        if (controller.signal.aborted) return
        if (now() - refreshed < PROGRESS_EVERY_MS) return
        refreshed = now()
        useVerification.getState().progress(replyId, characters)
      },
      now,
    })
  } finally {
    useVerification.getState().finish(replyId, controller)
  }
  const { record, markedContent } = verification
  useVerification.getState().setRecord(replyId, record)

  const stored = thread.messages()
  const reply = stored.find((message) => message.id === replyId)
  if (!reply) {
    return {
      started: true,
      record,
      version: markedContent ? 'skipped' : 'none',
    }
  }
  // A new version of a reply hides what follows it, and the screen cannot be
  // rewritten under a turn that is running.
  const last =
    !thread.busy() &&
    pathToVerify(stored, thread.activeRootId(), replyId) !== undefined
  if (!markedContent || !last) {
    thread.updateMessage(withVerification(reply, record))
    return {
      started: true,
      record,
      version: markedContent ? 'skipped' : 'none',
    }
  }

  // The version goes beside the reply, under the same parent, so a thread that
  // never had versions gets its messages linked first. Each message is written
  // once, with all that changes in it: two writes of the same message are
  // stored in the order they reach the disk, which may not be this one.
  const linked = hasBranching(stored) ? stored : backfillParentIds(stored)
  const verified = withVerification(
    linked.find((message) => message.id === replyId)!,
    record
  )
  const version = markedVersion(verified, markedContent, thread.newId(), now())
  const parent = withActiveChild(
    linked.find((message) => message.id === getParentId(verified))!,
    version.id
  )
  const written = linked.map((message) =>
    message.id === replyId
      ? verified
      : message.id === parent.id
        ? parent
        : message
  )
  written.forEach((message, index) => {
    if (message !== stored[index]) thread.updateMessage(message)
  })
  thread.addMessage(version)
  thread.show()
  return { started: true, record, version: 'shown' }
}
