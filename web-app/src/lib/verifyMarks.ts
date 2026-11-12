/**
 * Marks, in a copy of a reply, the statements a verification reported.
 *
 * The code writes the marks, not a model: each one goes right after a passage
 * the checks on the findings already found in the answer character for
 * character, and nothing else of the text changes. Reasoning and tool calls
 * are kept as they are, so the marked version still carries the sources the
 * statements were checked against.
 */
import type { ThreadContent } from '@janhq/core'
import type { ValidFinding } from '@/lib/verifyFindings'

/** Follows a statement no tool result of the turn says. */
export const UNVERIFIED_MARK = '(non verificato)'
/** Follows a statement a tool result of the turn says differently. */
export const CONTRADICTED_MARK = '(contraddetto dalla fonte)'

export type MarkedContent = {
  /** The reply with the marks: its text parts changed, the others the same. */
  content: ThreadContent[]
  /**
   * For each finding, in order, in how many places its quote is in the text.
   * Zero when no single text part holds it: the finding leaves no mark.
   */
  occurrences: number[]
  /** How many marks were written. */
  inserted: number
}

// A citation marker, a markdown link or a bare address: a mark that would
// fall inside one goes after it, so that it still works.
const UNBREAKABLE = /\[\[cite:[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/g
// What a quote may end with that the mark should not follow: spaces, line
// ends, and the bar that closes a table cell.
const TRAILING = /[\s|]+$/

/** Where the mark goes for the passage of `text` that ends at `end`. */
function markPosition(text: string, start: number, end: number): number {
  const position = start + text.slice(start, end).replace(TRAILING, '').length
  for (const span of text.matchAll(UNBREAKABLE)) {
    const spanEnd = span.index + span[0].length
    if (span.index < position && position < spanEnd) return spanEnd
  }
  return position
}

// A mark as it is written: a space, then the mark.
const UNVERIFIED = ` ${UNVERIFIED_MARK}`
const CONTRADICTED = ` ${CONTRADICTED_MARK}`
const MARKS = [UNVERIFIED, CONTRADICTED]

/**
 * `text` without the marks it already has, and the marks by the place in the
 * plain text where each of them was. Quotes are looked for in the plain text:
 * a mark is not part of what the reply says, and its leading space would make
 * a quote that ends in a space match where it did not before. A mark the
 * model wrote itself in the same words counts as one: it stays where it is.
 */
function unmark(text: string): { plain: string; marks: Map<number, string[]> } {
  let plain = ''
  const marks = new Map<number, string[]>()
  for (let i = 0; i < text.length;) {
    const mark = MARKS.find((m) => text.startsWith(m, i))
    if (mark) {
      marks.set(plain.length, [...(marks.get(plain.length) ?? []), mark])
      i += mark.length
    } else {
      plain += text[i++]
    }
  }
  return { plain, marks }
}

/**
 * `content` with the marks taken out of its text parts: the reply as the model
 * wrote it, which is what a verification has to judge.
 */
export function withoutMarks(content: ThreadContent[]): ThreadContent[] {
  return content.map((part) => {
    if (part.type !== 'text' || !part.text) return part
    const { plain, marks } = unmark(part.text.value)
    return marks.size === 0
      ? part
      : { ...part, text: { ...part.text, value: plain } }
  })
}

/**
 * The conversation as a model is sent it: the replies of the assistant
 * without the marks. A mark is a note for the person who reads the reply. A
 * model that reads marks in its earlier replies takes them for a way of
 * writing and adds them to its next ones, where no verification put them.
 * Messages of the user are sent as they are, whatever they say. A message
 * with no marks is returned as it is.
 */
export function withoutMarksForModel<
  M extends { role: string; parts: ReadonlyArray<{ type: string }> },
>(messages: M[]): M[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message
    let changed = false
    const parts = message.parts.map((part) => {
      const text = (part as { text?: unknown }).text
      if (part.type !== 'text' || typeof text !== 'string') return part
      const { plain, marks } = unmark(text)
      if (marks.size === 0) return part
      changed = true
      return { ...part, text: plain }
    })
    return changed ? { ...message, parts } : message
  })
}

/**
 * A text of the assistant as a model is sent it: without the marks. For the
 * text of a stopped reply that is sent back to be continued.
 */
export function withoutMarksInText(text: string): string {
  return unmark(text).plain
}

/**
 * Returns `content` with a mark after every place where the quote of a finding
 * is: `UNVERIFIED_MARK` for an unsupported statement, `CONTRADICTED_MARK` for
 * a contradicted one. A place that already has that mark is left alone, so two
 * findings on the same passage leave one mark of each kind, and marking a
 * reply again with the same findings changes nothing.
 */
export function markFindings(
  content: ThreadContent[],
  findings: ValidFinding[]
): MarkedContent {
  const occurrences = findings.map(() => 0)
  let inserted = 0
  const marked = content.map((part) => {
    if (part.type !== 'text' || !part.text) return part
    const { plain, marks } = unmark(part.text.value)
    let added = 0
    findings.forEach((finding, index) => {
      const mark =
        finding.verdict === 'contradicted' ? CONTRADICTED : UNVERIFIED
      const quote = unmark(finding.quote).plain
      if (!quote) return
      for (
        let start = plain.indexOf(quote);
        start !== -1;
        start = plain.indexOf(quote, start + quote.length)
      ) {
        occurrences[index]++
        const position = markPosition(plain, start, start + quote.length)
        const here = marks.get(position) ?? []
        if (!here.includes(mark)) {
          marks.set(position, [...here, mark])
          added++
        }
      }
    })
    if (added === 0) return part
    inserted += added
    let value = ''
    let from = 0
    for (const [position, here] of [...marks].sort((a, b) => a[0] - b[0])) {
      value += plain.slice(from, position) + here.join('')
      from = position
    }
    value += plain.slice(from)
    return { ...part, text: { ...part.text, value } }
  })
  return { content: marked, occurrences, inserted }
}
