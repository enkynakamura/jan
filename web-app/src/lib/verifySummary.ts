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

export function summarizeVerification(
  record: VerificationRecord
): VerificationSummary {
  const cut = record.truncated ? '; the output was cut by the token cap' : ''
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
          `; ${count(record.marks, 'mark')} written` +
          (unmarked > 0 ? `; ${unmarked} could not be marked` : '') +
          cut,
      }
    }
    case 'no-findings':
      return {
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
