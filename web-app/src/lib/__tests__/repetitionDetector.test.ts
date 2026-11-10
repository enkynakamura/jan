import { describe, it, expect } from 'vitest'
import {
  RepetitionMeter,
  measureBlock,
  REPETITION_STOP_R5,
} from '../repetitionDetector'

const unique = (n: number) =>
  Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

const cycle = (period: number, words: number) =>
  Array.from({ length: words }, (_, i) => `c${i % period}`).join(' ')

function feed(text: string, size: number) {
  const meter = new RepetitionMeter()
  let tripped = false
  for (let i = 0; i < text.length; i += size) {
    if (meter.push(text.slice(i, i + size))) tripped = true
  }
  if (meter.end()) tripped = true
  return { tripped, stats: meter.stats() }
}

describe('repetitionDetector', () => {
  it('one word repeated: R5 = 1 - 1/196, TTR = 1/200, trips', () => {
    const { tripped, stats } = feed("'Rally ".repeat(254), 7)
    expect(stats.words).toBe(254)
    expect(stats.windows).toBe(2)
    expect(stats.maxR5).toBeCloseTo(1 - 1 / 196, 12)
    expect(stats.minTTR).toBeCloseTo(1 / 200, 12)
    expect(tripped).toBe(true)
  })

  it('all words different: R5 = 0, TTR = 1, does not trip', () => {
    const { tripped, stats } = feed(unique(254), 11)
    expect(stats.windows).toBe(2)
    expect(stats.maxR5).toBe(0)
    expect(stats.minTTR).toBe(1)
    expect(tripped).toBe(false)
  })

  it('windows start every 50 words and need 200 words', () => {
    expect(measureBlock(unique(199))).toEqual({
      words: 199,
      windows: 0,
      maxR5: null,
      minTTR: null,
    })
    expect(measureBlock(unique(200)).windows).toBe(1)
    expect(measureBlock(unique(249)).windows).toBe(1)
    expect(measureBlock(unique(250)).windows).toBe(2)
  })

  it('a cycle of p words gives R5 = 1 - p/196: 40 stays below 0.8, 39 trips', () => {
    const forty = feed(cycle(40, 400), 13)
    expect(forty.stats.maxR5).toBeCloseTo(1 - 40 / 196, 12)
    expect(forty.stats.minTTR).toBeCloseTo(40 / 200, 12)
    expect(forty.tripped).toBe(false)

    const thirtyNine = feed(cycle(39, 400), 13)
    expect(thirtyNine.stats.maxR5).toBeCloseTo(1 - 39 / 196, 12)
    expect(thirtyNine.stats.maxR5 as number).toBeGreaterThanOrEqual(
      REPETITION_STOP_R5
    )
    expect(thirtyNine.tripped).toBe(true)
  })

  it('the result does not depend on how the text is cut into pieces', () => {
    const text =
      unique(120) + '\n\n' + cycle(3, 300) + '\t ' + unique(90) + '  tail'
    const whole = measureBlock(text)
    for (const size of [1, 2, 5, 64, 1000]) {
      expect(feed(text, size).stats).toEqual(whole)
    }
  })

  it('a word still being written counts only after end()', () => {
    const meter = new RepetitionMeter()
    meter.push(unique(199) + ' las')
    expect(meter.stats().words).toBe(199)
    meter.push('t')
    expect(meter.stats().words).toBe(199)
    meter.end()
    expect(meter.stats().words).toBe(200)
    expect(meter.stats().windows).toBe(1)
  })
})
