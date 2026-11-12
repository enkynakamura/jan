import { describe, it, expect } from 'vitest'
import { ContentType, type ThreadContent } from '@janhq/core'
import {
  readFindings,
  validFindings,
  type ValidFinding,
} from '../verifyFindings'
import {
  CONTRADICTED_MARK,
  UNVERIFIED_MARK,
  markFindings,
  withoutMarks,
  withoutMarksForModel,
  withoutMarksInText,
} from '../verifyMarks'

// Made-up text: nothing here comes from a real conversation.
const text = (value: string): ThreadContent => ({
  type: ContentType.Text,
  text: { value, annotations: [] },
})
const unsupported = (quote: string): ValidFinding => ({
  verdict: 'unsupported',
  quote,
  source: null,
  why: '',
})
const contradicted = (quote: string): ValidFinding => ({
  verdict: 'contradicted',
  quote,
  source: 'a passage',
  why: '',
})
const U = ` ${UNVERIFIED_MARK}`
const C = ` ${CONTRADICTED_MARK}`

/** The text of a one-part reply after marking. */
const mark = (value: string, ...findings: ValidFinding[]) =>
  markFindings([text(value)], findings).content[0].text?.value

describe('markFindings: where the mark goes', () => {
  it('follows the quote, and nothing else changes', () => {
    expect(
      mark(
        'The bridge opened in 1932. It is 412 metres long.',
        unsupported('The bridge opened in 1932.')
      )
    ).toBe(`The bridge opened in 1932.${U} It is 412 metres long.`)
  })

  it('says which of the two verdicts it is', () => {
    expect(
      mark(
        'It opened in 1932 and is 412 metres long.',
        contradicted('opened in 1932'),
        unsupported('412 metres long')
      )
    ).toBe(`It opened in 1932${C} and is 412 metres long${U}.`)
  })

  it('marks every place where the quote is', () => {
    const result = markFindings(
      [text('Built in steel. Rebuilt later, built in steel again.')],
      [unsupported('uilt in steel')]
    )
    expect(result.content[0].text?.value).toBe(
      `Built in steel${U}. Rebuilt later, built in steel${U} again.`
    )
    expect(result.occurrences).toEqual([2])
    expect(result.inserted).toBe(2)
  })

  it('does not count a quote that overlaps itself twice', () => {
    const result = markFindings([text('so so so so')], [unsupported('so so')])
    expect(result.content[0].text?.value).toBe(`so so${U} so so${U}`)
    expect(result.occurrences).toEqual([2])
  })

  it('goes before the spaces, line ends and table bars a quote ends with', () => {
    expect(
      mark('First line.\nSecond line.', unsupported('First line.\n'))
    ).toBe(`First line.${U}\nSecond line.`)
    expect(
      mark(
        '| Length | 412 m |\n| Lanes | 2 |',
        unsupported('| Length | 412 m |')
      )
    ).toBe(`| Length | 412 m${U} |\n| Lanes | 2 |`)
  })

  it('goes after a citation marker, a link or an address it would fall inside', () => {
    expect(
      mark(
        'Opened in 1932 [[cite:https://example.org/alda]].',
        unsupported('Opened in 1932 [[cite:https://example.org')
      )
    ).toBe(`Opened in 1932 [[cite:https://example.org/alda]]${U}.`)
    expect(
      mark(
        'See [the survey](https://example.org/survey) for details.',
        unsupported('See [the survey')
      )
    ).toBe(`See [the survey](https://example.org/survey)${U} for details.`)
    expect(
      mark(
        'Data at https://example.org/data/alda today.',
        unsupported('Data at https://example.org/data')
      )
    ).toBe(`Data at https://example.org/data/alda${U} today.`)
  })

  it('stays before a citation marker that starts right where the quote ends', () => {
    expect(
      mark(
        'Opened in 1932[[cite:https://example.org/alda]].',
        unsupported('Opened in 1932')
      )
    ).toBe(`Opened in 1932${U}[[cite:https://example.org/alda]].`)
  })

  it('goes between a statement and the citation marker that follows it', () => {
    expect(
      mark(
        'Opened in 1932 [[cite:https://example.org/alda]].',
        unsupported('Opened in 1932')
      )
    ).toBe(`Opened in 1932${U} [[cite:https://example.org/alda]].`)
  })
})

describe('markFindings: several findings', () => {
  it('writes one mark for two findings on the same passage', () => {
    const result = markFindings(
      [text('It opened in 1932.')],
      [unsupported('opened in 1932'), unsupported('opened in 1932')]
    )
    expect(result.content[0].text?.value).toBe(`It opened in 1932${U}.`)
    expect(result.occurrences).toEqual([1, 1])
    expect(result.inserted).toBe(1)
  })

  it('writes one mark for two quotes that end at the same place', () => {
    expect(
      mark(
        'It opened in 1932.',
        unsupported('It opened in 1932'),
        unsupported('in 1932')
      )
    ).toBe(`It opened in 1932${U}.`)
  })

  it('writes both marks, in the order of the findings, when the verdicts differ', () => {
    expect(
      mark(
        'It opened in 1932.',
        contradicted('opened in 1932'),
        unsupported('in 1932')
      )
    ).toBe(`It opened in 1932${C}${U}.`)
  })

  it('marks a quote inside another without moving either mark', () => {
    expect(
      mark(
        'It opened in 1932 after two years of work.',
        unsupported('opened in 1932 after two years of work'),
        contradicted('in 1932')
      )
    ).toBe(`It opened in 1932${C} after two years of work${U}.`)
  })

  it('finds every quote in the text as it was, not in the marks', () => {
    // "non verificato" is in the mark: a finding that quotes those words
    // must not be found in a mark written for another finding.
    const result = markFindings(
      [text('It opened in 1932.')],
      [unsupported('opened in 1932'), unsupported('non verificato')]
    )
    expect(result.content[0].text?.value).toBe(`It opened in 1932${U}.`)
    expect(result.occurrences).toEqual([1, 0])
  })
})

describe('markFindings: a reply already marked', () => {
  it('leaves a place that already has its mark', () => {
    const once = mark('It opened in 1932.', unsupported('opened in 1932'))
    const result = markFindings(
      [text(once as string)],
      [unsupported('opened in 1932')]
    )
    expect(result.content[0].text?.value).toBe(once)
    expect(result.occurrences).toEqual([1])
    expect(result.inserted).toBe(0)
  })

  it('adds the other mark, and then leaves both', () => {
    const findings = [unsupported('opened in 1932'), contradicted('in 1932')]
    const once = mark('It opened in 1932.', findings[0])
    const twice = mark(once as string, ...findings)
    // The mark that was there stays first.
    expect(twice).toBe(`It opened in 1932${U}${C}.`)
    expect(mark(twice as string, ...findings)).toBe(twice)
    expect(markFindings([text(twice as string)], findings).inserted).toBe(0)
  })
})

describe('markFindings: quotes and the marks already in the text', () => {
  it('does not find a quote that ends in a space where only a mark follows', () => {
    // A mark starts with a space: looked for in the marked text, the second
    // quote would be found at the end, where the reply does not have it.
    const findings = [
      unsupported('It opened in 1932'),
      contradicted('in 1932 '),
    ]
    const once = markFindings([text('It opened in 1932')], findings)
    expect(once.content[0].text?.value).toBe(`It opened in 1932${U}`)
    expect(once.occurrences).toEqual([1, 0])
    const again = markFindings(once.content, findings)
    expect(again.content).toEqual(once.content)
    expect(again.occurrences).toEqual([1, 0])
  })

  it('finds a quote that was copied from the marked reply, mark included', () => {
    const marked = `It opened in 1932${U} after two years.`
    const result = markFindings(
      [text(marked)],
      [contradicted(`in 1932${U} after two years`)]
    )
    expect(result.content[0].text?.value).toBe(
      `It opened in 1932${U} after two years${C}.`
    )
    expect(result.occurrences).toEqual([1])
  })

  it('does not find a quote inside a mark, or one that is only a mark', () => {
    const marked = `It opened in 1932${U}.`
    const result = markFindings(
      [text(marked)],
      [unsupported('non verificato'), unsupported(U), contradicted('1932 (non')]
    )
    expect(result.content[0].text?.value).toBe(marked)
    expect(result.occurrences).toEqual([0, 0, 0])
    expect(result.inserted).toBe(0)
  })

  it('keeps every mark that was already there where it was', () => {
    const marked = `One${U}${U} two${C}${U} three.`
    expect(mark(marked, unsupported('three'))).toBe(
      `One${U}${U} two${C}${U} three${U}.`
    )
  })
})

describe('markFindings: the parts of a reply', () => {
  const reasoning: ThreadContent = {
    type: ContentType.Reasoning,
    text: { value: 'I recall it opened in 1932.', annotations: [] },
  }
  const call = {
    type: ContentType.ToolCall,
    tool_call_id: 'c1',
    tool_name: 'web_fetch',
    input: { url: 'https://example.org/alda' },
    output: 'It opened in 1934.',
  } as ThreadContent
  const first = text('Let me check when it opened.')
  const last = text('It opened in 1932.')
  const content = [reasoning, first, call, last]

  it('marks the text parts and returns the others as they are', () => {
    const result = markFindings(content, [contradicted('opened in 1932')])
    expect(result.content).toHaveLength(4)
    expect(result.content[0]).toBe(reasoning)
    expect(result.content[1]).toBe(first)
    expect(result.content[2]).toBe(call)
    expect(result.content[3]).toEqual(text(`It opened in 1932${C}.`))
    // The reply that was passed in is not changed.
    expect(last.text?.value).toBe('It opened in 1932.')
    expect(reasoning.text?.value).toBe('I recall it opened in 1932.')
  })

  it('marks a quote in whichever text part holds it, and in all that do', () => {
    const result = markFindings(
      [text('It opened late.'), call, text('It opened late, in 1934.')],
      [unsupported('opened late')]
    )
    expect(result.content[0].text?.value).toBe(`It opened late${U}.`)
    expect(result.content[2].text?.value).toBe(`It opened late${U}, in 1934.`)
    expect(result.occurrences).toEqual([2])
  })

  it('leaves no mark for a quote that runs from one text part into the next', () => {
    // The findings are checked against the text parts joined by a newline.
    const result = markFindings(
      [first, call, last],
      [unsupported('when it opened.\nIt opened')]
    )
    expect(result.content).toEqual([first, call, last])
    expect(result.occurrences).toEqual([0])
    expect(result.inserted).toBe(0)
  })

  it('returns the same parts when there is nothing to mark', () => {
    const result = markFindings(content, [])
    expect(result).toEqual({ content, occurrences: [], inserted: 0 })
    expect(result.content[3]).toBe(last)
  })
})

describe('withoutMarks', () => {
  const call = {
    type: ContentType.ToolCall,
    tool_call_id: 'c1',
    tool_name: 'web_fetch',
    input: {},
    output: `It opened in 1934${U}.`,
  } as ThreadContent
  const reasoning: ThreadContent = {
    type: ContentType.Reasoning,
    text: { value: `I wrote${U} once.`, annotations: [] },
  }

  it('takes the marks out of the text parts and leaves the rest', () => {
    const plain = text('No marks here.')
    const content = [
      reasoning,
      call,
      text(`It opened in 1932${C}${U} after two years${U}.`),
      plain,
    ]
    const result = withoutMarks(content)
    expect(result[0]).toBe(reasoning)
    expect(result[1]).toBe(call)
    expect(result[2]).toEqual(text('It opened in 1932 after two years.'))
    expect(result[3]).toBe(plain)
  })

  it('gives back what was there before the marking', () => {
    const before = [text('It opened in 1932. It is 412 metres long.')]
    const marked = markFindings(before, [
      contradicted('opened in 1932'),
      unsupported('412 metres long'),
    ])
    expect(marked.inserted).toBe(2)
    expect(withoutMarks(marked.content)).toEqual(before)
  })
})

describe('markFindings: from the output of a verifier', () => {
  it('marks what the checks let through, and only that', () => {
    const answer =
      'The Alda bridge opened in 1932. It is 412 metres long. Its engineer was Marta Lindqvist.'
    const toolResults =
      'Alda bridge. Opened to traffic in 1934. Total length: 412 m.'
    const output = [
      '{"n": 1, "verdict": "contradicted", "quote": "The Alda bridge opened in 1932.", "source": "Opened to traffic in 1934.", "why": "The source gives 1934."}',
      '{"n": 2, "verdict": "unsupported", "quote": "Its engineer was Marta Lindqvist.", "source": null, "why": "No passage names the engineer."}',
      '{"n": 3, "verdict": "unsupported", "quote": "It is 412 meters long.", "source": null, "why": "Not in the answer as written."}',
    ].join('\n')
    const findings = validFindings(readFindings(output, answer, toolResults))
    const result = markFindings([text(answer)], findings)
    expect(result.content[0].text?.value).toBe(
      `The Alda bridge opened in 1932.${C} It is 412 metres long. Its engineer was Marta Lindqvist.${U}`
    )
    expect(result.occurrences).toEqual([1, 1])
    expect(result.inserted).toBe(2)
  })
})

describe('markFindings: made-up replies and findings, many', () => {
  // A repeatable generator (mulberry32): the same cases at every run.
  const generator = (seed: number) => () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const PIECES = [
    'The bridge',
    'opened in 1932',
    'is 412 metres long',
    'città',
    '東京',
    '🙂',
    '**bold**',
    '[[cite:https://example.org/a]]',
    '[the survey](https://example.org/s)',
    'https://example.org/data/alda',
    '(m)',
    '| cell |',
    'steel',
    'in 1932',
  ]
  const BETWEEN = [' ', ' ', ' ', '\n', '. ', ', ', '', ' | ', '\n\n']
  const UNBREAKABLE = /\[\[cite:[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/g
  const without = (value: string) => value.split(U).join('').split(C).join('')

  it('changes nothing but the marks, breaks no link, and is stable', () => {
    let marks = 0
    for (let n = 0; n < 500; n++) {
      const random = generator(n * 7919 + 13)
      const pick = (list: string[]) => list[Math.floor(random() * list.length)]
      const sentence = (length: number) =>
        Array.from(
          { length },
          (_, i) => (i ? pick(BETWEEN) : '') + pick(PIECES)
        ).join('')
      const parts = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
        sentence(3 + Math.floor(random() * 25))
      )
      const findings = Array.from({ length: Math.floor(random() * 6) }, () => {
        const characters = [...pick(parts)]
        const from = Math.floor(random() * characters.length)
        const quote = characters
          .slice(from, from + 6 + Math.floor(random() * 40))
          .join('')
        return random() < 0.5 ? unsupported(quote) : contradicted(quote)
      })
      const result = markFindings(parts.map(text), findings)
      const values = result.content.map((part) => part.text?.value as string)

      expect(values.map(without)).toEqual(parts)
      expect(values.map((value) => value.match(UNBREAKABLE))).toEqual(
        parts.map((value) => value.match(UNBREAKABLE))
      )
      const written = values.reduce(
        (sum, value, i) => sum + (value.length - parts[i].length),
        0
      )
      expect(written).toBeGreaterThanOrEqual(result.inserted * U.length)
      expect(written).toBeLessThanOrEqual(result.inserted * C.length)
      const again = markFindings(result.content, findings)
      expect(again.inserted).toBe(0)
      expect(again.content).toEqual(result.content)
      expect(again.occurrences).toEqual(result.occurrences)
      marks += result.inserted
    }
    // The cases do exercise the marking.
    expect(marks).toBeGreaterThan(1000)
  })
})

describe('withoutMarksInText', () => {
  it('takes the marks out of a text, and nothing else', () => {
    expect(
      withoutMarksInText(`It opened in 1932.${C} It is 412 metres${U}${C}`)
    ).toBe('It opened in 1932. It is 412 metres')
    expect(withoutMarksInText('It opened in 1934. (not a mark)')).toBe(
      'It opened in 1934. (not a mark)'
    )
    expect(withoutMarksInText('')).toBe('')
    // A stopped text is continued from its last character: spaces count.
    expect(withoutMarksInText(`\n- It opened in 1932.${U}\n- `)).toBe(
      '\n- It opened in 1932.\n- '
    )
  })
})

describe('withoutMarksForModel', () => {
  // Messages as the chat keeps them: a role and parts. Made-up text.
  const message = (
    role: string,
    ...parts: Array<{ type: string; text?: string; state?: string }>
  ) => ({ id: role, role, parts, metadata: { kept: true } })
  const part = (value: string) => ({ type: 'text', text: value })

  it('takes the marks out of the replies of the assistant', () => {
    const marked = message(
      'assistant',
      { type: 'reasoning', text: `I recall 1932.${U}` },
      part(`It opened in 1932.${C} It is 412 metres long.${U}`),
      { type: 'tool-web_fetch', state: 'output-available' },
      part(`| 1932 |${U}${C}\n`)
    )
    const [sent] = withoutMarksForModel([marked])
    expect(sent).toEqual({
      ...marked,
      parts: [
        // Only the text of the reply is marked: the rest is not touched.
        marked.parts[0],
        part('It opened in 1932. It is 412 metres long.'),
        marked.parts[2],
        part('| 1932 |\n'),
      ],
    })
    expect(sent.parts[0]).toBe(marked.parts[0])
    expect(sent.parts[2]).toBe(marked.parts[2])
  })

  it('takes out a mark the model wrote itself, which reads the same', () => {
    const imitated = message('assistant', part(`The bridge is old.${U}`))
    expect(withoutMarksForModel([imitated])[0].parts).toEqual([
      part('The bridge is old.'),
    ])
  })

  it('sends what the user wrote as it is', () => {
    const asked = message('user', part(`What does "${U.trim()}" mean?${U}`))
    expect(withoutMarksForModel([asked])[0]).toBe(asked)
  })

  it('returns a message without marks as it is, and keeps the order', () => {
    const plain = message('assistant', part('It opened in 1934.'))
    const marked = message('assistant', part(`It opened in 1932.${C}`))
    const asked = message('user', part('When?'))
    const sent = withoutMarksForModel([asked, plain, asked, marked])
    expect(sent[0]).toBe(asked)
    expect(sent[1]).toBe(plain)
    expect(sent[3]).not.toBe(marked)
    expect(sent.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    // The message that was passed in is not changed.
    expect(marked.parts[0].text).toBe(`It opened in 1932.${C}`)
  })

  it('sends a marked reply exactly as the reply was before it was marked', () => {
    const texts = [
      'The Alda bridge opened in 1932. It is 412 metres long.',
      '| year | 1932 |\n| length | 412 m |',
      'See [the survey](https://example.org/a) and [[cite:https://example.org/b]].',
    ]
    const before = texts.map(text)
    const marked = markFindings(before, [
      contradicted('The Alda bridge opened in 1932.'),
      unsupported('It is 412 metres long.'),
      unsupported('| year | 1932 |'),
      unsupported('See [the survey](https://example.org/a)'),
    ])
    expect(marked.inserted).toBe(4)
    const sent = withoutMarksForModel([
      message(
        'assistant',
        ...marked.content.map((p) => part(p.text?.value as string))
      ),
    ])
    expect(sent[0].parts).toEqual(texts.map(part))
  })
})
