/**
 * Reads what a verifier model wrote about one turn and checks every finding
 * against the turn itself, so that only findings the turn bears out are used.
 *
 * The verifier is asked for one JSON object per finding, or the line
 * `NO FINDINGS`. Models do not keep to one layout: the same model has written
 * the objects one per line, spread over several lines, and inside a `[...]`
 * list. The reader takes every JSON object it finds, wherever it starts, and
 * reports every other piece of text as an entry that is not a finding.
 *
 * A finding is used only if the code can confirm it:
 * - `verdict` is `contradicted` or `unsupported`;
 * - `quote` is in the answer character for character, and has words in it,
 *   not only a link, a `[[cite:...]]` marker or a `(m)`, `(d)`, `(e)` label;
 * - `source` is in the tool results character for character when the verdict
 *   is `contradicted`, and null when it is `unsupported`;
 * - it is among the first `FINDINGS_CAP` findings that pass the checks above.
 */

/** Findings used from one verification; valid ones past it are discarded. */
export const FINDINGS_CAP = 10

/** The whole output of a verifier that found nothing to report. */
export const NO_FINDINGS = 'NO FINDINGS'

export type FindingVerdict = 'contradicted' | 'unsupported'

/** Why an entry of the verifier's output is not used. */
export type FindingRejection =
  | 'not-json'
  | 'invalid-verdict'
  | 'quote-missing'
  | 'quote-not-found'
  | 'quote-differs-in-whitespace'
  | 'quote-without-words'
  | 'source-missing'
  | 'source-not-found'
  | 'source-differs-in-whitespace'
  | 'source-not-null'
  | 'over-cap'

/** One piece of the verifier's output, in the order it was written. */
export type FindingEntry = {
  /** The piece as written: the text of a JSON object, or any other text. */
  raw: string
  /** The object, when the piece is one. */
  finding?: Record<string, unknown>
  valid: boolean
  /** Empty when `valid`. */
  rejections: FindingRejection[]
}

export type FindingsReading = {
  /** The output was the `NO FINDINGS` line and nothing else. */
  noFindings: boolean
  entries: FindingEntry[]
}

/** A finding that passed every check. */
export type ValidFinding = {
  verdict: FindingVerdict
  quote: string
  /** The contradicting passage; null for `unsupported`. */
  source: string | null
  why: string
}

// Links, citation markers and provenance labels: what is left of a quote once
// these are taken out has to contain words.
const NOT_WORDS =
  /\[\[cite:[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+|\((?:m|d|e)\)/g
// Two word characters in a row that are neither decimal digits nor "_".
const TWO_LETTERS = /[\p{L}\p{Nl}\p{No}]{2}/u
const LIST_PUNCTUATION = /^[[\], ]+|[[\], ]+$/g
const FENCE = '```'

// Half of a surrogate pair. Strings are compared by UTF-16 unit, so a passage
// that ends in one would be found inside a character of the text.
const LONE_SURROGATE = /\p{Cs}/u

const collapseWhitespace = (s: string) =>
  s.split(/\s+/).filter(Boolean).join(' ')

/** Whether `passage` is in `text` character for character. */
const contains = (text: string, passage: string) =>
  !LONE_SURROGATE.test(passage) && text.includes(passage)

/**
 * The index just past the `}` that closes the `{` at `start`, or -1 when the
 * text ends first. Braces inside strings do not count.
 */
function objectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
    } else if (c === '{') {
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** The JSON object that starts at `start` and where it ends, if there is one. */
function objectAt(
  text: string,
  start: number
): { object: Record<string, unknown>; end: number } | undefined {
  const end = objectEnd(text, start)
  if (end === -1) return undefined
  try {
    // The slice starts with "{", so whatever parses is an object.
    return { object: JSON.parse(text.slice(start, end)), end }
  } catch {
    return undefined
  }
}

/**
 * Splits the verifier's output into its pieces: every complete JSON object,
 * and every other run of text up to the next `{` of its line or the end of
 * the line. Blank text, code fences and the bare punctuation of a list
 * (brackets and commas) are not pieces.
 */
export function splitFindings(
  text: string
): Array<{ raw: string; object?: Record<string, unknown> }> {
  const pieces: Array<{ raw: string; object?: Record<string, unknown> }> = []
  let i = 0
  while (i < text.length) {
    if (' \t\r\n'.includes(text[i])) {
      i++
      continue
    }
    if (text[i] === '{') {
      const found = objectAt(text, i)
      if (found) {
        pieces.push({ raw: text.slice(i, found.end), object: found.object })
        i = found.end
        continue
      }
    }
    // Up to the next brace of the line, so that a list written as
    // [ {...}, {...} ] does not hide the objects it holds.
    const newline = text.indexOf('\n', i)
    const lineEnd = newline === -1 ? text.length : newline
    const brace = text.indexOf('{', i + 1)
    const braceInLine = brace !== -1 && brace < lineEnd
    const end = braceInLine ? brace : lineEnd
    const rest = text.slice(i, end).trim()
    if (rest.replace(LIST_PUNCTUATION, '') && !rest.startsWith(FENCE)) {
      pieces.push({ raw: rest })
    }
    i = braceInLine ? end : lineEnd + 1
  }
  return pieces
}

function isNoFindings(text: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(FENCE))
  return lines.length === 1 && lines[0] === NO_FINDINGS
}

/** The checks of one finding against the turn, cap excluded. */
function rejectionsOf(
  finding: Record<string, unknown>,
  answer: string,
  toolResults: string
): FindingRejection[] {
  const rejections: FindingRejection[] = []
  const { verdict, quote, source } = finding
  if (verdict !== 'contradicted' && verdict !== 'unsupported') {
    rejections.push('invalid-verdict')
  }
  if (typeof quote !== 'string' || !quote) {
    rejections.push('quote-missing')
  } else {
    if (!contains(answer, quote)) {
      rejections.push(
        contains(collapseWhitespace(answer), collapseWhitespace(quote))
          ? 'quote-differs-in-whitespace'
          : 'quote-not-found'
      )
    }
    if (!TWO_LETTERS.test(quote.replace(NOT_WORDS, ' '))) {
      rejections.push('quote-without-words')
    }
  }
  if (verdict === 'contradicted') {
    if (typeof source !== 'string' || !source) {
      rejections.push('source-missing')
    } else if (!contains(toolResults, source)) {
      rejections.push(
        contains(collapseWhitespace(toolResults), collapseWhitespace(source))
          ? 'source-differs-in-whitespace'
          : 'source-not-found'
      )
    }
  } else if (verdict === 'unsupported' && source != null) {
    rejections.push('source-not-null')
  }
  return rejections
}

/**
 * Reads the verifier's output and checks each finding against the turn.
 *
 * @param text - What the verifier wrote, reasoning excluded.
 * @param answer - The text of the answer that was verified.
 * @param toolResults - The text of the tool results of that turn.
 */
export function readFindings(
  text: string,
  answer: string,
  toolResults: string
): FindingsReading {
  if (isNoFindings(text)) return { noFindings: true, entries: [] }
  const entries: FindingEntry[] = []
  let valid = 0
  for (const piece of splitFindings(text)) {
    if (!piece.object) {
      entries.push({ raw: piece.raw, valid: false, rejections: ['not-json'] })
      continue
    }
    const rejections = rejectionsOf(piece.object, answer, toolResults)
    if (rejections.length === 0 && valid >= FINDINGS_CAP) {
      rejections.push('over-cap')
    }
    if (rejections.length === 0) valid++
    entries.push({
      raw: piece.raw,
      finding: piece.object,
      valid: rejections.length === 0,
      rejections,
    })
  }
  return { noFindings: false, entries }
}

/** The findings of a reading that passed every check, in order. */
export function validFindings(reading: FindingsReading): ValidFinding[] {
  return reading.entries
    .filter((entry) => entry.valid)
    .map((entry) => {
      const { verdict, quote, source, why } = entry.finding as Record<
        string,
        unknown
      >
      return {
        verdict: verdict as FindingVerdict,
        quote: quote as string,
        source: (source ?? null) as string | null,
        why: typeof why === 'string' ? why : '',
      }
    })
}
