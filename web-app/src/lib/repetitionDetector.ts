/**
 * Repetition meter for one block of streamed model output (one reasoning part
 * or one text part). It mirrors `C:\strata-lab\scripts\misura_degrado.py`:
 * words are maximal runs of non-whitespace, windows hold REPETITION_WINDOW
 * words and start every REPETITION_STEP words from the start of the block.
 *
 * For one window:
 *   R5  = 1 - (distinct 5-word sequences / 5-word sequences in the window)
 *   TTR = distinct words / words in the window
 *
 * A block made of one word repeated gives R5 = 1 - 1/196 and TTR = 1/200.
 * A block that repeats a fixed sequence of p distinct words gives
 * R5 = 1 - p/196, so with the 0.8 threshold a cycle of 40 or more words does
 * not trip the meter (1 - 40/196 = 0.796).
 *
 * The threshold comes from the measurements of 2026-11-10 (PROTOCOLLO-VERIFICA,
 * section 9.2): highest healthy block 0.291, loop block 0.995. It is provisional.
 */

export const REPETITION_WINDOW = 200
export const REPETITION_STEP = 50
export const REPETITION_NGRAM = 5
export const REPETITION_STOP_R5 = 0.8

export type RepetitionStats = {
  /** Words seen so far, the pending partial word excluded until `end()`. */
  words: number
  /** Windows measured so far. */
  windows: number
  /** Highest R5 over the measured windows; null when no window was measured. */
  maxR5: number | null
  /** Lowest TTR over the measured windows; null when no window was measured. */
  minTTR: number | null
}

export function windowR5(window: string[]): number {
  const total = window.length - REPETITION_NGRAM + 1
  const seen = new Set<string>()
  for (let i = 0; i < total; i++) {
    seen.add(window.slice(i, i + REPETITION_NGRAM).join(' '))
  }
  return 1 - seen.size / total
}

export function windowTTR(window: string[]): number {
  return new Set(window).size / window.length
}

export class RepetitionMeter {
  private carry = ''
  /** Words not yet dropped; `kept[0]` is word number `base` of the block. */
  private kept: string[] = []
  private base = 0
  private total = 0
  private nextStart = 0
  private windows = 0
  private maxR5: number | null = null
  private minTTR: number | null = null

  /**
   * Feed the next piece of the block. Returns true when a window measured by
   * this call has R5 at or above REPETITION_STOP_R5.
   */
  push(delta: string): boolean {
    const text = this.carry + delta
    const parts = text.split(/\s+/)
    // The last piece is a word still being written unless the text ends with
    // whitespace, in which case split leaves an empty string there.
    this.carry = parts.pop() as string
    return this.addWords(parts.filter((w) => w !== ''))
  }

  /** Close the block: the pending partial word, if any, becomes a word. */
  end(): boolean {
    const last = this.carry
    this.carry = ''
    return last === '' ? false : this.addWords([last])
  }

  stats(): RepetitionStats {
    return {
      words: this.total,
      windows: this.windows,
      maxR5: this.maxR5,
      minTTR: this.minTTR,
    }
  }

  private addWords(words: string[]): boolean {
    let tripped = false
    for (const w of words) {
      this.kept.push(w)
      this.total++
      if (this.total === this.nextStart + REPETITION_WINDOW) {
        const from = this.nextStart - this.base
        const window = this.kept.slice(from, from + REPETITION_WINDOW)
        const r5 = windowR5(window)
        const ttr = windowTTR(window)
        this.windows++
        if (this.maxR5 === null || r5 > this.maxR5) this.maxR5 = r5
        if (this.minTTR === null || ttr < this.minTTR) this.minTTR = ttr
        if (r5 >= REPETITION_STOP_R5) tripped = true
        this.nextStart += REPETITION_STEP
        this.kept.splice(0, this.nextStart - this.base)
        this.base = this.nextStart
      }
    }
    return tripped
  }
}

/** Measure a whole block at once. */
export function measureBlock(text: string): RepetitionStats {
  const meter = new RepetitionMeter()
  meter.push(text)
  meter.end()
  return meter.stats()
}
