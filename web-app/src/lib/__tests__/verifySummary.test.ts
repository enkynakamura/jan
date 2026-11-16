import { describe, it, expect } from 'vitest'
import type { FindingRejection } from '../verifyFindings'
import type { VerificationRecord } from '../verifyReply'
import {
  REJECTION_LABELS,
  SOURCE_DOUBT_LABELS,
  summarizeVerification,
} from '../verifySummary'

const record = (more: Partial<VerificationRecord>): VerificationRecord => ({
  at: 1,
  outcome: 'no-findings',
  seconds: 2,
  maxOutputTokens: 8192,
  truncated: false,
  toolCalls: [],
  output: '',
  reasoning: '',
  entries: [],
  marks: 0,
  ...more,
})
const valid = (occurrences: number) => ({
  raw: '{}',
  finding: {},
  valid: true,
  rejections: [] as FindingRejection[],
  occurrences,
})
const discarded = {
  raw: '{}',
  finding: {},
  valid: false,
  rejections: ['quote-not-found'] as FindingRejection[],
}
const prose = {
  raw: 'That is all.',
  valid: false,
  rejections: ['not-json'] as FindingRejection[],
}

describe('summarizeVerification', () => {
  it('counts the findings, the discarded entries and the marks', () => {
    expect(
      summarizeVerification(
        record({
          outcome: 'findings',
          entries: [valid(1), valid(2), discarded, prose],
          marks: 3,
        })
      )
    ).toEqual({
      tone: 'findings',
      text: '2 findings, 2 discarded; 3 marks written',
    })
    expect(
      summarizeVerification(
        record({ outcome: 'findings', entries: [valid(1)], marks: 1 })
      ).text
    ).toBe('1 finding; 1 mark written')
  })

  it('says when a finding could not be marked', () => {
    expect(
      summarizeVerification(
        record({ outcome: 'findings', entries: [valid(1), valid(0)], marks: 1 })
      ).text
    ).toBe('2 findings; 1 mark written; 1 could not be marked')
  })

  it('does not count as unmarked a finding whose marks were not counted', () => {
    const uncounted = { ...valid(1), occurrences: undefined }
    expect(
      summarizeVerification(
        record({ outcome: 'findings', entries: [uncounted], marks: 0 })
      ).text
    ).toBe('1 finding; 0 marks written')
  })

  it('says when every mark was already there', () => {
    expect(
      summarizeVerification(
        record({ outcome: 'findings', entries: [valid(1)], marks: 0 })
      ).text
    ).toBe('1 finding; 0 marks written')
  })

  it('says that nothing was found', () => {
    expect(summarizeVerification(record({ outcome: 'no-findings' }))).toEqual({
      tone: 'clean',
      text: 'the verifier reported no findings',
    })
  })

  it('says each way a verification can fail to do its job', () => {
    const text = (more: Partial<VerificationRecord>) => {
      const summary = summarizeVerification(record(more))
      expect(summary.tone).toBe('problem')
      return summary.text
    }
    expect(
      text({ outcome: 'nothing-valid', entries: [discarded, prose] })
    ).toBe('2 entries listed, none passed the checks')
    expect(text({ outcome: 'nothing-valid', entries: [discarded] })).toBe(
      '1 entry listed, none passed the checks'
    )
    expect(text({ outcome: 'unreadable' })).toBe(
      'the verifier wrote neither findings nor NO FINDINGS'
    )
    expect(text({ outcome: 'no-sources' })).toBe(
      'not run, the conversation has no tool results or attached files to check the answer against'
    )
    expect(
      text({ outcome: 'tool-call', toolCalls: ['web_fetch', 'web_search'] })
    ).toBe(
      'the verifier called a tool instead of answering (web_fetch, web_search)'
    )
    expect(text({ outcome: 'error', error: 'connection refused' })).toBe(
      'failed (connection refused)'
    )
    expect(text({ outcome: 'stopped' })).toBe('stopped')
  })

  it('adds that the output was cut, whatever the outcome', () => {
    const cut = '; the output was cut by the token cap'
    expect(
      summarizeVerification(
        record({
          outcome: 'findings',
          entries: [valid(1)],
          marks: 1,
          truncated: true,
        })
      ).text
    ).toBe(`1 finding; 1 mark written${cut}`)
    expect(
      summarizeVerification(record({ outcome: 'no-findings', truncated: true }))
        .text
    ).toBe(`the verifier reported no findings${cut}`)
    expect(
      summarizeVerification(record({ outcome: 'unreadable', truncated: true }))
        .text
    ).toBe(`the verifier wrote neither findings nor NO FINDINGS${cut}`)
    expect(
      summarizeVerification(
        record({ outcome: 'nothing-valid', entries: [prose], truncated: true })
      ).text
    ).toBe(`1 entry listed, none passed the checks${cut}`)
  })
})

describe('summarizeVerification: a reasoning the engine closed', () => {
  const closed = (more: Partial<VerificationRecord>) =>
    summarizeVerification(record({ reasoningCut: true, ...more }))

  it('does not give as clean a check that found nothing and was cut short', () => {
    expect(closed({ outcome: 'no-findings' })).toEqual({
      tone: 'problem',
      text: 'the verifier reported no findings, but its reasoning was cut short: the check may be incomplete',
    })
    // Without the cut it is clean, as before.
    expect(summarizeVerification(record({ outcome: 'no-findings' }))).toEqual({
      tone: 'clean',
      text: 'the verifier reported no findings',
    })
  })

  it('says with the findings that there may be more', () => {
    expect(
      closed({ outcome: 'findings', entries: [valid(1)], marks: 1 })
    ).toEqual({
      tone: 'findings',
      text: '1 finding; 1 mark written; the reasoning was cut short, the check may be incomplete',
    })
    expect(closed({ outcome: 'unreadable' }).text).toBe(
      'the verifier wrote neither findings nor NO FINDINGS; the reasoning was cut short, the check may be incomplete'
    )
    expect(closed({ outcome: 'nothing-valid', entries: [prose] }).text).toBe(
      '1 entry listed, none passed the checks; the reasoning was cut short, the check may be incomplete'
    )
  })

  it('says both when the output was cut too', () => {
    expect(closed({ outcome: 'no-findings', truncated: true }).text).toBe(
      'the verifier reported no findings, but its reasoning was cut short: the check may be incomplete; the output was cut by the token cap'
    )
    expect(
      closed({
        outcome: 'findings',
        entries: [valid(1)],
        marks: 1,
        truncated: true,
      }).text
    ).toBe(
      '1 finding; 1 mark written; the output was cut by the token cap; the reasoning was cut short, the check may be incomplete'
    )
  })
})

describe('SOURCE_DOUBT_LABELS', () => {
  it('has words for every doubt, all different', () => {
    expect(Object.keys(SOURCE_DOUBT_LABELS).sort()).toEqual([
      'source-missing',
      'source-not-found',
      'source-not-null',
    ])
    const labels = Object.values(SOURCE_DOUBT_LABELS)
    expect(new Set(labels).size).toBe(3)
    expect(labels.every((label) => label.length > 5)).toBe(true)
  })
})

describe('summarizeVerification: a series of runs', () => {
  const run = (more: Partial<VerificationRecord> = {}) => record(more)
  const found = run({ outcome: 'findings', entries: [valid(1)], marks: 1 })
  const series = (
    runs: VerificationRecord[],
    more: Partial<VerificationRecord> = {}
  ) => record({ repetitions: runs.length, runs, ...more })

  it('says how many runs, and what they found together', () => {
    expect(
      summarizeVerification(
        series([found, run(), found], {
          outcome: 'findings',
          entries: [valid(1), valid(2)],
          marks: 3,
        })
      )
    ).toEqual({ tone: 'findings', text: '3 runs: 2 findings; 3 marks written' })
    expect(
      summarizeVerification(
        series([found, found], {
          outcome: 'findings',
          entries: [valid(0)],
          marks: 0,
        })
      ).text
    ).toBe('2 runs: 1 finding; 0 marks written; 1 could not be marked')
  })

  it('is clean only when every run was made and none found or lost anything', () => {
    expect(
      summarizeVerification(series([run(), run()], { outcome: 'no-findings' }))
    ).toEqual({ tone: 'clean', text: '2 runs: no findings in any run' })
    expect(
      summarizeVerification(
        series([run(), run({ reasoningCut: true }), run({ truncated: true })], {
          outcome: 'no-findings',
        })
      )
    ).toEqual({
      tone: 'problem',
      text: '3 runs: no findings in any run; the reasoning was cut short in 1 run; the output was cut by the token cap in 1 run',
    })
  })

  it('says how many runs gave nothing usable', () => {
    const unreadable = run({ outcome: 'unreadable' })
    const toolCall = run({ outcome: 'tool-call', toolCalls: ['x'] })
    expect(
      summarizeVerification(
        series([run(), unreadable, toolCall], { outcome: 'nothing-valid' })
      )
    ).toEqual({
      tone: 'problem',
      text: '3 runs: no finding passed the checks; 2 runs gave nothing usable',
    })
    expect(
      summarizeVerification(
        series([found, unreadable], {
          outcome: 'findings',
          entries: [valid(1)],
          marks: 1,
        })
      )
    ).toEqual({
      tone: 'findings',
      text: '2 runs: 1 finding; 1 mark written; 1 run gave nothing usable',
    })
  })

  it('says when the series was stopped or failed before its last run', () => {
    expect(
      summarizeVerification(
        series([found, run({ outcome: 'stopped' })], {
          outcome: 'findings',
          entries: [valid(1)],
          marks: 1,
          repetitions: 5,
        })
      )
    ).toEqual({
      tone: 'findings',
      text: '1 of 5 runs (stopped): 1 finding; 1 mark written',
    })
    expect(
      summarizeVerification(
        series(
          [run(), run(), run({ outcome: 'error', error: 'engine down' })],
          {
            outcome: 'no-findings',
            error: 'engine down',
            repetitions: 4,
          }
        )
      )
    ).toEqual({
      tone: 'problem',
      text: '2 of 4 runs (failed: engine down): no findings in any run',
    })
  })

  it('leaves the marks out of the words for a run of a series', () => {
    expect(summarizeVerification(found, { marks: false }).text).toBe(
      '1 finding'
    )
    expect(summarizeVerification(found).text).toBe('1 finding; 1 mark written')
    expect(
      summarizeVerification(
        run({
          outcome: 'findings',
          entries: [valid(0), discarded],
          reasoningCut: true,
        }),
        { marks: false }
      ).text
    ).toBe(
      '1 finding, 1 discarded; the reasoning was cut short, the check may be incomplete'
    )
  })
})

describe('REJECTION_LABELS', () => {
  it('has words for every reason, all different', () => {
    const labels = Object.values(REJECTION_LABELS)
    expect(labels).toHaveLength(11)
    expect(new Set(labels).size).toBe(11)
    expect(labels.every((label) => label.length > 5)).toBe(true)
  })
})
