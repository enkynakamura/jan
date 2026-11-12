import { create } from 'zustand'
import type { VerificationRecord } from '@/lib/verifyReply'

/** A verification in progress. */
type RunningVerification = {
  threadId: string
  /** The characters the verifier has written so far, reasoning included. */
  characters: number
  controller: AbortController
}

type VerificationState = {
  /** The verifications in progress, by the id of the reply being verified. */
  running: Record<string, RunningVerification>
  /**
   * The record of the last verification of each reply verified since the app
   * started, by reply id. The lasting copy is in the reply's metadata; this
   * one is what the reply shows right away, wherever the conversation is.
   */
  records: Record<string, VerificationRecord>
  start: (
    messageId: string,
    threadId: string,
    controller: AbortController
  ) => void
  progress: (messageId: string, characters: number) => void
  /**
   * The verification that `controller` belongs to is over, whatever its
   * outcome. One that was stopped can end after the next one on the same
   * reply has started: that one stays.
   */
  finish: (messageId: string, controller: AbortController) => void
  setRecord: (messageId: string, record: VerificationRecord) => void
  /** Stops the verification of a reply. */
  stop: (messageId: string) => void
  /** Stops the verifications of a thread's replies. */
  stopThread: (threadId: string) => void
}

const without = <T>(entries: Record<string, T>, ids: string[]) => {
  const rest = { ...entries }
  for (const id of ids) delete rest[id]
  return rest
}

export const useVerification = create<VerificationState>()((set, get) => ({
  running: {},
  records: {},
  start: (messageId, threadId, controller) =>
    set((state) => ({
      running: {
        ...state.running,
        [messageId]: { threadId, characters: 0, controller },
      },
    })),
  progress: (messageId, characters) =>
    set((state) => {
      const entry = state.running[messageId]
      if (!entry) return state
      return {
        running: { ...state.running, [messageId]: { ...entry, characters } },
      }
    }),
  finish: (messageId, controller) =>
    set((state) =>
      state.running[messageId]?.controller === controller
        ? { running: without(state.running, [messageId]) }
        : state
    ),
  setRecord: (messageId, record) =>
    set((state) => ({ records: { ...state.records, [messageId]: record } })),
  // A stopped verification is no longer running from this moment, not from
  // when its request gives up: what waits for it to end can go on at once.
  stop: (messageId) => {
    const entry = get().running[messageId]
    if (!entry) return
    entry.controller.abort()
    get().finish(messageId, entry.controller)
  },
  stopThread: (threadId) => {
    const ids = Object.entries(get().running)
      .filter(([, entry]) => entry.threadId === threadId)
      .map(([id]) => id)
    for (const id of ids) get().running[id].controller.abort()
    if (ids.length > 0) {
      set((state) => ({ running: without(state.running, ids) }))
    }
  },
}))

/** Whether a reply of the thread is being verified. */
export const isVerifyingThread =
  (threadId: string) => (state: Pick<VerificationState, 'running'>) =>
    Object.values(state.running).some((entry) => entry.threadId === threadId)
