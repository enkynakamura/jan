import { describe, it, expect } from 'vitest'
import {
  FINDINGS_CAP,
  readFindings,
  splitFindings,
  validFindings,
} from '../verifyFindings'

// A made-up turn: nothing here comes from a real conversation.
const answer = [
  'The Alda bridge opened in 1932 [[cite:https://example.org/alda]].',
  'It is 412 metres long and carries two lanes.',
  'Its engineer was Marta Lindqvist (m).',
  'See [the survey](https://example.org/survey) for details.',
].join('\n')
const toolResults = [
  'Alda bridge. Opened to traffic in 1934.',
  'Total length: 412 m. Two lanes.',
].join('\n')

const contradicted = {
  n: 1,
  verdict: 'contradicted',
  quote: 'The Alda bridge opened in 1932',
  source: 'Opened to traffic in 1934.',
  why: 'The source gives 1934.',
}
const unsupported = {
  n: 2,
  verdict: 'unsupported',
  quote: 'Its engineer was Marta Lindqvist',
  source: null,
  why: 'No passage names the engineer.',
}

const read = (text: string) => readFindings(text, answer, toolResults)
const rejectionsOf = (finding: Record<string, unknown>) =>
  read(JSON.stringify(finding)).entries[0].rejections

describe('readFindings: layouts', () => {
  const bothValid = (text: string) => {
    const reading = read(text)
    expect(reading.noFindings).toBe(false)
    expect(reading.entries.map((e) => e.finding)).toEqual([
      contradicted,
      unsupported,
    ])
    expect(reading.entries.map((e) => e.valid)).toEqual([true, true])
    expect(reading.entries.map((e) => e.rejections)).toEqual([[], []])
  }

  it('reads one object per line', () => {
    bothValid(
      `${JSON.stringify(contradicted)}\n${JSON.stringify(unsupported)}\n`
    )
  })

  it('reads objects spread over several lines', () => {
    bothValid(
      `${JSON.stringify(contradicted, null, 2)}\n${JSON.stringify(unsupported, null, 2)}`
    )
  })

  it('reads a list written on one line', () => {
    bothValid(JSON.stringify([contradicted, unsupported]))
  })

  it('reads a list spread over several lines', () => {
    bothValid(JSON.stringify([contradicted, unsupported], null, 2))
  })

  it('reads two objects on the same line with no list around them', () => {
    bothValid(`${JSON.stringify(contradicted)} ${JSON.stringify(unsupported)}`)
  })

  it('reads through a code fence', () => {
    bothValid(
      '```json\n' +
        JSON.stringify(contradicted) +
        '\n' +
        JSON.stringify(unsupported) +
        '\n```'
    )
  })

  it('keeps the text of each object as written', () => {
    const first = JSON.stringify(contradicted, null, 2)
    const reading = read(`[\n${first},\n${JSON.stringify(unsupported)}\n]`)
    expect(reading.entries[0].raw).toBe(first)
    expect(reading.entries[1].raw).toBe(JSON.stringify(unsupported))
  })

  it('reports the prose around the objects as entries that are not findings', () => {
    const reading = read(
      `Here are the findings:\n${JSON.stringify(contradicted)}\nThat is all.`
    )
    expect(reading.entries.map((e) => [e.raw, e.valid, e.rejections])).toEqual([
      ['Here are the findings:', false, ['not-json']],
      [JSON.stringify(contradicted), true, []],
      ['That is all.', false, ['not-json']],
    ])
  })

  it('reads braces and escaped quotes inside strings', () => {
    const tricky = {
      ...unsupported,
      why: 'The answer says "engineer" {sic}; the results have no } such { word.',
    }
    const reading = read(JSON.stringify(tricky, null, 2))
    expect(reading.entries).toHaveLength(1)
    expect(reading.entries[0].finding).toEqual(tricky)
    expect(reading.entries[0].valid).toBe(true)
  })

  it('reads a string with one escaped quote before a brace, or ending in a backslash', () => {
    const oddQuote = {
      ...unsupported,
      why: 'A 5" pipe } is not in the results.',
    }
    const backslash = { ...unsupported, why: 'Not in C:\\data\\' }
    const reading = read(
      `${JSON.stringify(oddQuote)}\n${JSON.stringify(backslash)}`
    )
    expect(reading.entries.map((e) => e.finding)).toEqual([oddQuote, backslash])
    expect(reading.entries.map((e) => e.valid)).toEqual([true, true])
  })

  it('keeps the complete objects of an output cut off by the token cap', () => {
    const cut = JSON.stringify(unsupported).slice(0, 60)
    const reading = read(`${JSON.stringify(contradicted)}\n${cut}`)
    expect(reading.entries.map((e) => [e.raw, e.valid, e.rejections])).toEqual([
      [JSON.stringify(contradicted), true, []],
      [cut, false, ['not-json']],
    ])
  })

  it('reports each line of a multi-line object that was cut off', () => {
    const lines = JSON.stringify(unsupported, null, 2).split('\n').slice(0, 3)
    const reading = read(lines.join('\n'))
    expect(reading.entries.map((e) => e.raw)).toEqual(
      lines.map((line) => line.trim())
    )
    expect(reading.entries.every((e) => !e.valid)).toBe(true)
  })

  it('reports an object that is not valid JSON, and reads the next one', () => {
    const broken =
      '{"n": 1, "verdict": "unsupported", "quote": "It is "412" metres"}'
    const reading = read(`${broken}\n${JSON.stringify(unsupported)}`)
    expect(reading.entries.map((e) => [e.raw, e.rejections])).toEqual([
      [broken, ['not-json']],
      [JSON.stringify(unsupported), []],
    ])
  })

  it('has no entries for an empty output', () => {
    expect(read('')).toEqual({ noFindings: false, entries: [] })
    expect(read(' \n\n')).toEqual({ noFindings: false, entries: [] })
    expect(read('[]')).toEqual({ noFindings: false, entries: [] })
  })
})

describe('readFindings: NO FINDINGS', () => {
  it('accepts the line alone, with blank lines or a fence around it', () => {
    for (const text of [
      'NO FINDINGS',
      '\n  NO FINDINGS  \n',
      '```\nNO FINDINGS\n```',
    ]) {
      expect(read(text)).toEqual({ noFindings: true, entries: [] })
    }
  })

  it('does not accept it next to anything else', () => {
    const withProse = read('NO FINDINGS\nEvery statement is supported.')
    expect(withProse.noFindings).toBe(false)
    expect(withProse.entries.map((e) => e.rejections)).toEqual([
      ['not-json'],
      ['not-json'],
    ])

    const withFinding = read(`NO FINDINGS\n${JSON.stringify(unsupported)}`)
    expect(withFinding.noFindings).toBe(false)
    expect(withFinding.entries.map((e) => e.valid)).toEqual([false, true])
  })

  it('does not accept other wordings', () => {
    expect(read('No findings.').noFindings).toBe(false)
    expect(read('NO FINDINGS.').noFindings).toBe(false)
  })
})

describe('readFindings: checks on each finding', () => {
  it('requires one of the two verdicts', () => {
    expect(rejectionsOf({ ...unsupported, verdict: 'wrong' })).toEqual([
      'invalid-verdict',
    ])
    const noVerdict: Record<string, unknown> = { ...unsupported }
    delete noVerdict.verdict
    expect(rejectionsOf(noVerdict)).toEqual(['invalid-verdict'])
  })

  it('requires a quote', () => {
    expect(rejectionsOf({ ...unsupported, quote: '' })).toEqual([
      'quote-missing',
    ])
    expect(rejectionsOf({ ...unsupported, quote: 412 })).toEqual([
      'quote-missing',
    ])
  })

  it('requires the quote to be in the answer character for character', () => {
    expect(
      rejectionsOf({
        ...unsupported,
        quote: 'Its engineer was Marta Lindquist',
      })
    ).toEqual(['quote-not-found'])
    // In the tool results, not in the answer.
    expect(
      rejectionsOf({ ...unsupported, quote: 'Opened to traffic in 1934.' })
    ).toEqual(['quote-not-found'])
  })

  it('does not find a quote that ends in half of a character of the answer', () => {
    const smile = '\ud83d\ude42'
    const reading = readFindings(
      JSON.stringify({ ...unsupported, quote: 'opened' + smile[0] }),
      `It opened${smile} in 1932.`,
      ''
    )
    expect(reading.entries[0].rejections).toEqual(['quote-not-found'])
    // The whole character is found.
    expect(
      readFindings(
        JSON.stringify({ ...unsupported, quote: 'opened' + smile }),
        `It opened${smile} in 1932.`,
        ''
      ).entries[0].valid
    ).toBe(true)
  })

  it('tells a quote that differs only in whitespace, and still discards it', () => {
    expect(
      rejectionsOf({
        ...unsupported,
        quote: 'It is 412 metres long and carries two lanes. Its engineer',
      })
    ).toEqual(['quote-differs-in-whitespace'])
  })

  it('requires words in the quote', () => {
    for (const quote of [
      '[[cite:https://example.org/alda]]',
      '[the survey](https://example.org/survey)',
      '(m)',
      '412',
    ]) {
      expect(rejectionsOf({ ...unsupported, quote })).toEqual([
        'quote-without-words',
      ])
    }
    // Words next to a marker are a statement.
    expect(
      rejectionsOf({
        ...unsupported,
        quote: 'Its engineer was Marta Lindqvist (m)',
      })
    ).toEqual([])
  })

  it('counts superscripts and fractions as word characters, digits not', () => {
    const reading = (quote: string) =>
      readFindings(
        JSON.stringify({ ...unsupported, quote }),
        'The area is x² and the ratio ½ of 12 in all.',
        ''
      ).entries[0].rejections
    expect(reading('x²')).toEqual([])
    expect(reading('½')).toEqual(['quote-without-words'])
    expect(reading('12')).toEqual(['quote-without-words'])
  })

  it('lists every reason a finding fails', () => {
    expect(
      rejectionsOf({ verdict: 'maybe', quote: '(d)', source: 'x' })
    ).toEqual(['invalid-verdict', 'quote-not-found', 'quote-without-words'])
  })
})

// What a finding says of the sources does not decide whether it is used: the
// statement is in the answer and the verifier disputes it. It decides whether
// the code goes by its verdict.
describe('readFindings: what a finding says of the sources', () => {
  const entryOf = (finding: Record<string, unknown>) =>
    read(JSON.stringify(finding)).entries[0]
  const used = (sourceDoubt?: string) => ({
    valid: true,
    rejections: [],
    ...(sourceDoubt ? { sourceDoubt } : {}),
  })

  it('goes by a contradicted finding whose source is in the sources', () => {
    const entry = entryOf(contradicted)
    expect(entry).toMatchObject(used())
    expect(entry).not.toHaveProperty('sourceDoubt')
  })

  it('finds the source whatever its spaces and line ends', () => {
    // The sources have a line end where the passage has a space.
    for (const source of [
      'Opened to traffic in 1934. Total length: 412 m.',
      '  Opened to\ttraffic in\n1934.\nTotal   length: 412 m. ',
    ]) {
      const entry = entryOf({ ...contradicted, source })
      expect(entry).toMatchObject(used())
      expect(entry).not.toHaveProperty('sourceDoubt')
    }
  })

  it('does not find a source that differs in anything else', () => {
    for (const source of [
      // The figure the finding rests on is another.
      'Opened to traffic in 1935. Total length: 412 m.',
      // A word is left out, a character is added, the case is another.
      'Opened in 1934.',
      'Opened to traffic in 1934..',
      'opened to traffic in 1934.',
      // Spaces inside a word, or none between two.
      'Open ed to traffic in 1934.',
      'Opened totraffic in 1934.',
      // In the answer, not in the sources.
      'It is 412 metres long',
    ]) {
      expect(entryOf({ ...contradicted, source })).toMatchObject(
        used('source-not-found')
      )
    }
  })

  it('says when a contradicted finding has no source at all', () => {
    const noSource: Record<string, unknown> = { ...contradicted }
    delete noSource.source
    for (const finding of [
      noSource,
      { ...contradicted, source: null },
      { ...contradicted, source: '' },
      { ...contradicted, source: ' \n' },
      { ...contradicted, source: 7 },
    ]) {
      expect(entryOf(finding)).toMatchObject(used('source-missing'))
    }
  })

  it('says when an unsupported finding gives a source, found or not', () => {
    for (const source of ['Opened to traffic in 1934.', 'x', '']) {
      expect(entryOf({ ...unsupported, source })).toMatchObject(
        used('source-not-null')
      )
    }
    const noSource: Record<string, unknown> = { ...unsupported }
    delete noSource.source
    for (const finding of [unsupported, noSource]) {
      const entry = entryOf(finding)
      expect(entry).toMatchObject(used())
      expect(entry).not.toHaveProperty('sourceDoubt')
    }
  })

  it('has nothing to say of the source of a finding that is not used', () => {
    const entry = entryOf({
      ...contradicted,
      quote: 'not in the answer',
      source: 'Opened to traffic in 1935.',
    })
    expect(entry).toMatchObject({
      valid: false,
      rejections: ['quote-not-found'],
    })
    expect(entry).not.toHaveProperty('sourceDoubt')
  })

  it('counts a finding with a doubt on its source towards the cap', () => {
    const doubted = { ...contradicted, source: 'Opened to traffic in 1935.' }
    const reading = read(
      Array.from({ length: FINDINGS_CAP + 1 }, () =>
        JSON.stringify(doubted)
      ).join('\n')
    )
    expect(reading.entries.map((e) => e.rejections[0] ?? 'valid')).toEqual([
      ...Array.from({ length: FINDINGS_CAP }, () => 'valid'),
      'over-cap',
    ])
    expect(reading.entries[FINDINGS_CAP]).not.toHaveProperty('sourceDoubt')
  })
})

describe('readFindings: cap', () => {
  it('discards the valid findings past the cap, and only those', () => {
    const invalid = { ...unsupported, quote: 'not in the answer' }
    const lines = [
      invalid,
      ...Array.from({ length: FINDINGS_CAP + 2 }, (_, i) => ({
        ...unsupported,
        n: i + 1,
      })),
      invalid,
    ].map((finding) => JSON.stringify(finding))
    const reading = read(lines.join('\n'))

    expect(reading.entries.map((e) => e.rejections[0] ?? 'valid')).toEqual([
      'quote-not-found',
      ...Array.from({ length: FINDINGS_CAP }, () => 'valid'),
      'over-cap',
      'over-cap',
      'quote-not-found',
    ])
    expect(validFindings(reading)).toHaveLength(FINDINGS_CAP)
  })
})

describe('validFindings', () => {
  it('returns the findings that passed, in order, with their fields', () => {
    const noSource: Record<string, unknown> = { ...unsupported, why: 7 }
    delete noSource.source
    const reading = read(
      [
        JSON.stringify(contradicted),
        'not a finding',
        JSON.stringify({ ...unsupported, quote: 'not in the answer' }),
        JSON.stringify(noSource),
      ].join('\n')
    )
    expect(validFindings(reading)).toEqual([
      {
        verdict: 'contradicted',
        quote: contradicted.quote,
        source: contradicted.source,
        why: contradicted.why,
      },
      {
        verdict: 'unsupported',
        quote: unsupported.quote,
        source: null,
        why: '',
      },
    ])
  })
})

describe('validFindings: a finding with a doubt on its source', () => {
  it('is given as unsupported, without the source', () => {
    const reading = read(
      [
        { ...contradicted, source: 'Opened to traffic in 1935.' },
        contradicted,
        { ...contradicted, source: null },
        { ...unsupported, source: 'Opened to traffic in 1934.' },
      ]
        .map((finding) => JSON.stringify(finding))
        .join('\n')
    )
    const asUnsupported = (finding: { quote: string; why: string }) => ({
      verdict: 'unsupported',
      quote: finding.quote,
      source: null,
      why: finding.why,
    })
    expect(validFindings(reading)).toEqual([
      asUnsupported(contradicted),
      {
        verdict: 'contradicted',
        quote: contradicted.quote,
        source: contradicted.source,
        why: contradicted.why,
      },
      asUnsupported(contradicted),
      asUnsupported(unsupported),
    ])
    // What the verifier wrote stays in the entry as it was.
    expect(reading.entries[0].finding).toMatchObject({
      verdict: 'contradicted',
      source: 'Opened to traffic in 1935.',
    })
  })
})

describe('splitFindings', () => {
  it('does not treat list punctuation or fences as pieces', () => {
    expect(splitFindings('[\n],\n```json\n```\n , ')).toEqual([])
  })

  it('keeps text that follows an object on its line', () => {
    const object = JSON.stringify(unsupported)
    expect(splitFindings(`${object} (second pass)`)).toEqual([
      { raw: object, object: unsupported },
      { raw: '(second pass)' },
    ])
  })
})
