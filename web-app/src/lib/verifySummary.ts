/**
 * A verification in words, for the reply it belongs to and for the notice.
 * The text is written to follow "Verification: ".
 */
import type { FindingRejection, SourceDoubt } from '@/lib/verifyFindings'
import type { VerificationRecord } from '@/lib/verifyReply'

export type VerificationSummary = {
  /** `clean`: nothing to report; `findings`: statements were reported;
   * `problem`: the verification did not do its job. */
  tone: 'clean' | 'findings' | 'problem'
  text: string
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

/** A series of runs (see `verifySeries`): what they found together. */
function summarizeSeries(
  record: VerificationRecord,
  runs: VerificationRecord[]
): VerificationSummary {
  const last = runs[runs.length - 1]
  const done = runs.filter(
    (run) => run.outcome !== 'stopped' && run.outcome !== 'error'
  )
  const asked = record.repetitions ?? runs.length
  const head =
    done.length === asked
      ? count(done.length, 'run')
      : `${done.length} of ${count(asked, 'run')} (${
          last.outcome === 'stopped' ? 'stopped' : `failed: ${last.error}`
        })`
  const valid = record.entries.filter((entry) => entry.valid)
  const unmarked = valid.filter((entry) => entry.occurrences === 0).length
  const main =
    record.outcome === 'findings'
      ? count(valid.length, 'finding') +
        `; ${count(record.marks, 'mark')} written` +
        (unmarked > 0 ? `; ${unmarked} could not be marked` : '')
      : record.outcome === 'no-findings'
        ? 'no findings in any run'
        : 'no finding passed the checks'
  const unusable = done.filter(
    (run) => run.outcome !== 'findings' && run.outcome !== 'no-findings'
  ).length
  const cutShort = done.filter((run) => run.reasoningCut).length
  const capped = done.filter((run) => run.truncated).length
  return {
    tone:
      record.outcome === 'findings'
        ? 'findings'
        : record.outcome === 'no-findings' &&
            done.length === asked &&
            cutShort === 0
          ? 'clean'
          : 'problem',
    text:
      `${head}: ${main}` +
      (unusable > 0 ? `; ${count(unusable, 'run')} gave nothing usable` : '') +
      (cutShort > 0
        ? `; the reasoning was cut short in ${count(cutShort, 'run')}`
        : '') +
      (capped > 0
        ? `; the output was cut by the token cap in ${count(capped, 'run')}`
        : ''),
  }
}

/**
 * `marks: false` for a run of a series: its findings are marked with those of
 * the other runs, and the count is in the summary of the series.
 */
export function summarizeVerification(
  record: VerificationRecord,
  options: { marks?: boolean } = {}
): VerificationSummary {
  if (record.runs) return summarizeSeries(record, record.runs)
  const cut =
    (record.truncated ? '; the output was cut by the token cap' : '') +
    // With no findings it is said in the sentence itself, below.
    (record.reasoningCut && record.outcome !== 'no-findings'
      ? '; the reasoning was cut short, the check may be incomplete'
      : '')
  switch (record.outcome) {
    case 'findings': {
      const valid = record.entries.filter((entry) => entry.valid)
      const discarded = record.entries.length - valid.length
      const unmarked = valid.filter((entry) => entry.occurrences === 0).length
      return {
        tone: 'findings',
        text:
          count(valid.length, 'finding') +
          (discarded > 0 ? `, ${discarded} discarded` : '') +
          (options.marks === false
            ? ''
            : `; ${count(record.marks, 'mark')} written` +
              (unmarked > 0 ? `; ${unmarked} could not be marked` : '')) +
          cut,
      }
    }
    case 'no-findings':
      // Nothing found by a verifier that was stopped on the way is not a
      // clean result.
      return record.reasoningCut
        ? {
            tone: 'problem',
            text: `the verifier reported no findings, but its reasoning was cut short: the check may be incomplete${cut}`,
          }
        : {
            tone: 'clean',
            text: `the verifier reported no findings${cut}`,
          }
    case 'nothing-valid':
      return {
        tone: 'problem',
        text: `${count(record.entries.length, 'entry', 'entries')} listed, none passed the checks${cut}`,
      }
    case 'unreadable':
      return {
        tone: 'problem',
        text: `the verifier wrote neither findings nor NO FINDINGS${cut}`,
      }
    case 'no-sources':
      return {
        tone: 'problem',
        text: 'not run, the conversation has no tool results or attached files to check the answer against',
      }
    case 'tool-call':
      return {
        tone: 'problem',
        text: `the verifier called a tool instead of answering (${record.toolCalls.join(', ')})`,
      }
    case 'error':
      return { tone: 'problem', text: `failed (${record.error})` }
    case 'stopped':
      return { tone: 'problem', text: 'stopped' }
  }
}

/** Why a piece of the verifier's output was not used. */
export const REJECTION_LABELS: Record<FindingRejection, string> = {
  'not-json': 'not a finding',
  'invalid-verdict': 'unknown verdict',
  'quote-missing': 'no quote',
  'quote-not-found': 'the quote is not in the answer',
  'quote-differs-in-whitespace':
    'the quote differs from the answer in its spaces',
  'quote-without-words': 'the quote has no words',
  'source-missing': 'no source passage',
  'source-not-found': 'the source passage is not in the tool results',
  'source-differs-in-whitespace':
    'the source passage differs from the tool results in its spaces',
  'source-not-null': 'a source passage was given for an unsupported statement',
  'over-cap': 'past the limit of findings',
}

/** Why a finding is taken as unverified, whatever it says of the sources. */
export const SOURCE_DOUBT_LABELS: Record<SourceDoubt, string> = {
  'source-missing': 'no source passage was given',
  'source-not-found': 'the source passage was not found in the sources',
  'source-not-null': 'a source passage was given for an unsupported statement',
}
