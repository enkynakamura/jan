import { describe, it, expect } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { guardRepetition, type RepetitionStop } from '../repetitionGuard'

type Chunk = { type: string; id?: string; delta?: string }

function block(kind: 'reasoning' | 'text', id: string, deltas: string[]) {
  return [
    { type: `${kind}-start`, id },
    ...deltas.map((delta) => ({ type: `${kind}-delta`, id, delta })),
    { type: `${kind}-end`, id },
  ]
}

const repeated = (n: number) => Array.from({ length: n }, () => "'Rally ")
const varied = (n: number) => Array.from({ length: n }, (_, i) => `w${i} `)

async function run(chunks: Chunk[]) {
  const stops: RepetitionStop[] = []
  const source = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c as UIMessageChunk)
      controller.close()
    },
  })
  const reader = guardRepetition(source, (s) => stops.push(s)).getReader()
  const out: Chunk[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out.push(value as Chunk)
  }
  return { out, stops }
}

describe('repetitionGuard', () => {
  it('passes a varied reply through unchanged and does not trip', async () => {
    const chunks = [
      { type: 'start' },
      ...block('reasoning', 'r1', varied(400)),
      ...block('text', 't1', varied(300)),
      { type: 'finish' },
    ]
    const { out, stops } = await run(chunks)
    expect(out).toEqual(chunks)
    expect(stops).toEqual([])
  })

  it('trips once on a reasoning block that repeats one word', async () => {
    const chunks = [
      { type: 'start' },
      ...block('reasoning', 'r1', repeated(600)),
      { type: 'finish' },
    ]
    const { out, stops } = await run(chunks)
    expect(stops).toHaveLength(1)
    expect(stops[0].part).toBe('reasoning')
    expect(stops[0].words).toBe(200)
    expect(stops[0].r5).toBeCloseTo(1 - 1 / 196, 12)
    expect(stops[0].ttr).toBeCloseTo(1 / 200, 12)

    const marks = out.filter((c) => c.type === 'message-metadata')
    expect(marks).toEqual([
      { type: 'message-metadata', messageMetadata: { repetitionStop: stops[0] } },
    ])
    // The mark follows the 200th word: `start`, `reasoning-start`, 200 deltas.
    expect(out.indexOf(marks[0])).toBe(202)
    // Everything else is the input, in order.
    expect(out.filter((c) => c.type !== 'message-metadata')).toEqual(chunks)
  })

  it('does not measure text blocks', async () => {
    const { stops } = await run([
      { type: 'start' },
      ...block('text', 't1', repeated(600)),
      { type: 'finish' },
    ])
    expect(stops).toEqual([])
  })

  it('measures each reasoning block on its own', async () => {
    // 150 + 150 repeated words: neither block fills a 200-word window.
    const { stops } = await run([
      { type: 'start' },
      ...block('reasoning', 'r1', repeated(150)),
      ...block('reasoning', 'r2', repeated(150)),
      { type: 'finish' },
    ])
    expect(stops).toEqual([])
  })
})
