import type { UIMessageChunk } from 'ai'
import { RepetitionMeter } from '@/lib/repetitionDetector'

/** What the guard leaves on the message it stopped, under `repetitionStop`. */
export type RepetitionStop = {
  part: 'reasoning'
  r5: number
  ttr: number
  words: number
}

type TextChunk = { type: string; id?: string; delta?: string }

/**
 * Measures every reasoning block of a reply while it streams and reports the
 * first one that starts repeating itself (see `repetitionDetector`). Every
 * chunk is passed on unchanged. On the first trip, and only then, a
 * `message-metadata` chunk carrying `repetitionStop` follows the chunk that
 * tripped, and `onTrip` is called; the caller ends the turn.
 *
 * Text blocks are not measured here: the threshold was set on reasoning only.
 * Each reasoning block has its own meter, as in the measurements the threshold
 * comes from.
 */
export function guardRepetition(
  stream: ReadableStream<UIMessageChunk>,
  onTrip: (stop: RepetitionStop) => void
): ReadableStream<UIMessageChunk> {
  const meters = new Map<string, RepetitionMeter>()
  let tripped = false
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        if (tripped) return
        const c = chunk as TextChunk
        if (c.id === undefined) return
        let meter: RepetitionMeter | undefined
        let over = false
        if (c.type === 'reasoning-start') {
          meters.set(c.id, new RepetitionMeter())
        } else if (c.type === 'reasoning-delta') {
          meter = meters.get(c.id)
          if (meter && c.delta) over = meter.push(c.delta)
        } else if (c.type === 'reasoning-end') {
          meter = meters.get(c.id)
          if (meter) over = meter.end()
          meters.delete(c.id)
        }
        if (!meter || !over) return
        tripped = true
        const stats = meter.stats()
        const stop: RepetitionStop = {
          part: 'reasoning',
          r5: stats.maxR5 as number,
          ttr: stats.minTTR as number,
          words: stats.words,
        }
        controller.enqueue({
          type: 'message-metadata',
          messageMetadata: { repetitionStop: stop },
        } as UIMessageChunk)
        onTrip(stop)
      },
    })
  )
}
