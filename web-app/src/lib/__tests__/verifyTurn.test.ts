import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  ChatCompletionRole,
  ContentType,
  MessageStatus,
  type ThreadContent,
  type ThreadMessage,
} from '@janhq/core'
import {
  buildPacket,
  lastTurn,
  toolOutputText,
  verifyRequest,
} from '../verifyTurn'

// A made-up thread: nothing here comes from a real conversation.
let nextId = 0
const message = (
  role: ChatCompletionRole,
  content: ThreadContent[],
  metadata?: Record<string, unknown>
): ThreadMessage => ({
  id: `m${++nextId}`,
  object: 'thread.message',
  thread_id: 't1',
  role,
  content,
  status: MessageStatus.Ready,
  created_at: nextId,
  completed_at: nextId,
  metadata,
})
const text = (value: string): ThreadContent => ({
  type: ContentType.Text,
  text: { value, annotations: [] },
})
const reasoning = (value: string): ThreadContent => ({
  type: ContentType.Reasoning,
  text: { value, annotations: [] },
})
const call = (
  id: string,
  name: string,
  input: unknown,
  output?: unknown,
  errorText?: string
): ThreadContent =>
  ({
    type: ContentType.ToolCall,
    tool_call_id: id,
    tool_name: name,
    input,
    output,
    ...(errorText ? { error_text: errorText } : {}),
  }) as ThreadContent
const user = (...content: ThreadContent[]) =>
  message(ChatCompletionRole.User, content)
const assistant = (...content: ThreadContent[]) =>
  message(ChatCompletionRole.Assistant, content)

describe('buildPacket, for one turn with nothing attached', () => {
  const request = user(text('How long is the Alda bridge?'), {
    type: ContentType.Image,
    image_url: { url: 'data:image/png;base64,AAAA' },
  })
  const reply = assistant(
    reasoning('I recall about 400 metres, but I should look it up.'),
    call('c1', 'web_search', { query: 'Alda bridge length' }, [
      { type: 'text', text: 'Alda bridge. ' },
      { type: 'text', text: 'Total length: 412 m.' },
    ]),
    text('Let me read the survey page.'),
    reasoning('The survey should have the opening year.'),
    call(
      'c2',
      'web_fetch',
      { url: 'https://example.org/alda' },
      'Opened in 1934.'
    ),
    call(
      'c3',
      'web_fetch',
      { url: 'https://example.org/gone' },
      undefined,
      'Error: 404'
    ),
    call('c4', 'web_fetch', { url: 'https://example.org/slow' }),
    text('The bridge is 412 metres long and opened in 1934.')
  )
  const packet = buildPacket([request, reply])

  it('writes the request, the tool calls with their results and the answer, in order', () => {
    expect(packet.text).toBe(
      [
        '[USER REQUEST]',
        'How long is the Alda bridge?',
        '(image_url attachment, not shown)',
        '',
        '[TOOL CALL] web_search',
        '{"query":"Alda bridge length"}',
        '[TOOL RESULT]',
        'Alda bridge. Total length: 412 m.',
        '',
        '[ANSWER]',
        'Let me read the survey page.',
        '',
        '[TOOL CALL] web_fetch',
        '{"url":"https://example.org/alda"}',
        '[TOOL RESULT]',
        'Opened in 1934.',
        '',
        '[TOOL CALL] web_fetch',
        '{"url":"https://example.org/gone"}',
        '[TOOL ERROR]',
        'Error: 404',
        '',
        '[TOOL CALL] web_fetch',
        '{"url":"https://example.org/slow"}',
        '[TOOL RESULT]',
        '(none)',
        '',
        '[ANSWER]',
        'The bridge is 412 metres long and opened in 1934.',
      ].join('\n')
    )
  })

  it('leaves the reasoning out', () => {
    expect(packet.text).not.toContain('I recall')
    expect(packet.text).not.toContain('opening year')
  })

  it('returns the answer and the tool results the findings are checked against', () => {
    expect(packet.answer).toBe(
      'Let me read the survey page.\nThe bridge is 412 metres long and opened in 1934.'
    )
    expect(packet.sources).toBe(
      'Alda bridge. Total length: 412 m.\nOpened in 1934.'
    )
    expect(packet.sourceCount).toBe(2)
    expect(packet.conversation).toBe(false)
  })

  it('counts no tool results for a reply without tools, or with failed calls only', () => {
    expect(
      buildPacket([request, assistant(text('About 400 metres.'))])
    ).toMatchObject({ sources: '', sourceCount: 0 })
    expect(
      buildPacket([
        request,
        assistant(
          call('c1', 'web_fetch', {}, undefined, 'Error: 404'),
          text('?')
        ),
      ]).sourceCount
    ).toBe(0)
  })

  it('counts an empty result as a result', () => {
    const empty = buildPacket([
      request,
      assistant(call('c1', 'web_fetch', {}, ''), text('Nothing there.')),
    ])
    expect(empty.sourceCount).toBe(1)
    expect(empty.text).toContain('[TOOL RESULT]\n\n\n[ANSWER]')
  })

  it('reads the error of a call from the metadata of the reply too', () => {
    const failed = message(
      ChatCompletionRole.Assistant,
      [call('c9', 'web_fetch', {}), text('It failed.')],
      { toolErrors: { c9: 'Tool execution denied by user' } }
    )
    expect(buildPacket([request, failed]).text).toContain(
      '[TOOL ERROR]\nTool execution denied by user'
    )
  })

  it('shows the result of a call that has both a result and an error', () => {
    const both = assistant(
      call('c1', 'web_fetch', {}, 'Opened in 1934.', 'Error: late'),
      text('1934.')
    )
    const packet = buildPacket([request, both])
    expect(packet.text).toContain('[TOOL RESULT]\nOpened in 1934.')
    expect(packet.text).not.toContain('[TOOL ERROR]')
    expect(packet.sourceCount).toBe(1)
  })

  it('writes a call without input as null, and other parts by their type', () => {
    const odd = assistant(call('c1', 'list_files', undefined, 'a.txt'), {
      type: ContentType.Image,
      image_url: { url: 'data:image/png;base64,AAAA' },
    })
    expect(buildPacket([request, odd]).text).toContain(
      '[TOOL CALL] list_files\nnull\n[TOOL RESULT]\na.txt\n\n(image_url part, not shown)'
    )
  })
})

describe('buildPacket, for a conversation', () => {
  const file = (name: string | undefined, content: string) => ({
    name,
    content,
  })
  const first = message(
    ChatCompletionRole.User,
    [text('Tell me about the bridge in this file.')],
    {
      inline_file_contents: [
        file('survey.pdf', 'Alda bridge survey.\nTotal length: 412 m.'),
        file(undefined, 'Engineer: Marta Lindqvist.'),
        file('empty.txt', ''),
        null,
      ],
    }
  )
  const firstReply = message(
    ChatCompletionRole.Assistant,
    [
      reasoning('I should open the page of the town.'),
      call(
        'c1',
        'web_fetch',
        { url: 'https://example.org/alda' },
        'Opened in 1934.'
      ),
      call('c2', 'web_fetch', { url: 'https://example.org/gone' }),
      text('It is a bridge 412 metres long, opened in 1932.'),
    ],
    { toolErrors: { c2: 'Error: 404' } }
  )
  const second = user(text('Do you agree with the file?'))
  const secondReply = assistant(
    reasoning('Nothing new to open, I think.'),
    call('c3', 'web_search', { query: 'alda' }, 'No results.'),
    text('Yes: it opened in 1934 and Marta Lindqvist built it.')
  )
  const packet = buildPacket([first, firstReply, second, secondReply])

  it('writes every turn with its request, its files and its tool results, and only the last answer', () => {
    expect(packet.text).toBe(
      [
        '[TURN 1]',
        '[USER REQUEST]',
        'Tell me about the bridge in this file.',
        '[ATTACHED FILE] survey.pdf',
        'Alda bridge survey.\nTotal length: 412 m.',
        '[ATTACHED FILE] attachment',
        'Engineer: Marta Lindqvist.',
        '',
        '[TOOL CALL] web_fetch',
        '{"url":"https://example.org/alda"}',
        '[TOOL RESULT]',
        'Opened in 1934.',
        '',
        '[TOOL CALL] web_fetch',
        '{"url":"https://example.org/gone"}',
        '[TOOL ERROR]',
        'Error: 404',
        '',
        '[TURN 2]',
        '[USER REQUEST]',
        'Do you agree with the file?',
        '',
        '[TOOL CALL] web_search',
        '{"query":"alda"}',
        '[TOOL RESULT]',
        'No results.',
        '',
        '[ANSWER]',
        'Yes: it opened in 1934 and Marta Lindqvist built it.',
      ].join('\n')
    )
    expect(packet.conversation).toBe(true)
  })

  it('leaves out the answer of the earlier turn, and all the reasoning', () => {
    expect(packet.text).not.toContain('opened in 1932')
    expect(packet.text).not.toContain('I should open')
    expect(packet.text).not.toContain('Nothing new')
    expect(packet.answer).toBe(
      'Yes: it opened in 1934 and Marta Lindqvist built it.'
    )
  })

  it('counts as sources the files and the tool results of every turn', () => {
    expect(packet.sources).toBe(
      [
        'Alda bridge survey.\nTotal length: 412 m.',
        'Engineer: Marta Lindqvist.',
        'Opened in 1934.',
        'No results.',
      ].join('\n')
    )
    expect(packet.sourceCount).toBe(4)
  })

  it('is a conversation as soon as a file is attached to the only request', () => {
    const only = buildPacket([first, assistant(text('It is 412 metres long.'))])
    expect(only.conversation).toBe(true)
    expect(only.sourceCount).toBe(2)
    expect(only.text.startsWith('[TURN 1]\n[USER REQUEST]\n')).toBe(true)
    expect(only.text.endsWith('\n\n[ANSWER]\nIt is 412 metres long.')).toBe(
      true
    )
  })

  it('is a conversation with an earlier turn that opened nothing, and has no sources then', () => {
    const plain = buildPacket([
      user(text('Hello')),
      assistant(text('Hello.')),
      user(text('How long is the bridge?')),
      assistant(text('About 400 metres.')),
    ])
    expect(plain).toMatchObject({
      conversation: true,
      sources: '',
      sourceCount: 0,
    })
    expect(plain.text).toBe(
      [
        '[TURN 1]',
        '[USER REQUEST]',
        'Hello',
        '',
        '[TURN 2]',
        '[USER REQUEST]',
        'How long is the bridge?',
        '',
        '[ANSWER]',
        'About 400 metres.',
      ].join('\n')
    )
  })

  it('takes as requests the messages of the user only', () => {
    const note = message(ChatCompletionRole.System, [
      text('A note of the app.'),
    ])
    const withNote = buildPacket([
      user(text('How long is the bridge?')),
      note,
      assistant(text('About 400 metres.')),
    ])
    expect(withNote.text).toBe(
      [
        '[TURN 1]',
        '[USER REQUEST]',
        'How long is the bridge?',
        '',
        '[ANSWER]',
        'About 400 metres.',
      ].join('\n')
    )
  })

  it('writes the tool calls of a reply that another reply follows in the same turn', () => {
    const twoReplies = buildPacket([
      user(text('How long is the bridge?')),
      assistant(call('c1', 'web_fetch', {}, 'Total length: 412 m.')),
      assistant(text('412 metres.')),
    ])
    expect(twoReplies.text).toBe(
      [
        '[TURN 1]',
        '[USER REQUEST]',
        'How long is the bridge?',
        '',
        '[TOOL CALL] web_fetch',
        '{}',
        '[TOOL RESULT]',
        'Total length: 412 m.',
        '',
        '[ANSWER]',
        '412 metres.',
      ].join('\n')
    )
    expect(twoReplies.sourceCount).toBe(1)
  })
})

describe('toolOutputText', () => {
  it('keeps a string as it is', () => {
    expect(toolOutputText('Title: Alda\n\n412 m')).toBe('Title: Alda\n\n412 m')
  })

  it('joins the text items of a list with nothing between them', () => {
    expect(
      toolOutputText([
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ])
    ).toBe('onetwo')
  })

  it('names an item that carries data instead of showing it', () => {
    expect(
      toolOutputText([
        { type: 'text', text: 'Plot saved. ' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { data: 'AAAA' },
      ])
    ).toBe('Plot saved. (image, not shown)(data, not shown)')
  })

  it('writes anything else as JSON', () => {
    const search = {
      kind: 'web',
      query: 'alda',
      results: [{ url: 'u', text: 'è' }],
    }
    expect(toolOutputText(search)).toBe(
      '{"kind":"web","query":"alda","results":[{"url":"u","text":"è"}]}'
    )
    expect(
      toolOutputText([{ type: 'resource', uri: 'file:///a' }, 7, null])
    ).toBe('{"type":"resource","uri":"file:///a"}7null')
    expect(toolOutputText(['plain', { text: 5 }])).toBe('"plain"{"text":5}')
    expect(toolOutputText(42)).toBe('42')
  })
})

describe('lastTurn', () => {
  const q1 = user(text('first question'))
  const a1 = assistant(text('first answer'))
  const q2 = user(text('second question'))
  const a2 = assistant(text('second answer'))

  it('is the last reply and the user message before it', () => {
    expect(lastTurn([q1, a1, q2, a2])).toEqual({ request: q2, reply: a2 })
    expect(lastTurn([q1, a1])).toEqual({ request: q1, reply: a1 })
  })

  it('is undefined when the conversation does not end with a reply', () => {
    expect(lastTurn([q1, a1, q2])).toBeUndefined()
    expect(lastTurn([])).toBeUndefined()
  })

  it('is undefined when no user message comes before the reply', () => {
    expect(lastTurn([a1])).toBeUndefined()
  })
})

describe('verifyRequest', () => {
  it('puts the turn between the markers, unchanged', () => {
    const turn = '[ANSWER]\ncosts $& and $1, {TURN}, `x`'
    const request = verifyRequest(turn)
    expect(request.endsWith(`\n<<<TURN\n${turn}\nTURN>>>\n`)).toBe(true)
    expect(request.startsWith('The text between the markers is one turn')).toBe(
      true
    )
  })

  it('puts a conversation between its own markers, with its own wording', () => {
    const text = '[TURN 1]\ncosts $& and $1'
    const request = verifyRequest(text, true)
    expect(
      request.endsWith(`\n<<<CONVERSATION\n${text}\nCONVERSATION>>>\n`)
    ).toBe(true)
    expect(
      request.startsWith('The text between the markers is a conversation')
    ).toBe(true)
    expect(request).toContain(
      'The answers to the earlier requests are left out.'
    )
    expect(request).not.toContain('TURN>>>')
    // The two wordings ask for the same findings in the same form.
    const form = (wording: string) =>
      wording.slice(
        wording.indexOf('Output at most 10 findings'),
        wording.indexOf('Escape every string')
      )
    expect(form(request).replace('of the sources', 'of the tool results')).toBe(
      form(verifyRequest(text))
    )
  })

  // The tools of the thread are offered with the request, and the rules of a
  // thread may ask for them to be used: a verifier called one instead of
  // answering.
  it('says in both wordings not to call tools', () => {
    const sentence =
      ' Do not call any tool: your whole reply is the findings, or NO FINDINGS.\n'
    for (const request of [verifyRequest('x'), verifyRequest('x', true)]) {
      expect(request.split(sentence)).toHaveLength(2)
      // With the other things not to do, before the form of the findings.
      expect(request.indexOf(sentence)).toBeLessThan(
        request.indexOf('Output at most 10 findings')
      )
      expect(request.indexOf(sentence)).toBeGreaterThan(
        request.indexOf('Do not use what you remember')
      )
    }
  })

  // The wording was tried on real turns: findings depend on it. A change to
  // the text has to be tried again before this hash is updated. The sentence
  // about tools was added after those trials.
  it('is the wording that was tried, with the sentence about tools', () => {
    const hash = createHash('sha256')
      .update(verifyRequest('{TURN_NO_REASONING}'), 'utf8')
      .digest('hex')
    expect(hash).toBe(
      '8e322c7b1dfe68519a9d12c5ce8a8e13e33f21f1bb7ae453f50fd9ef8c81dfe6'
    )
  })

  // The wording for a conversation is the one above with the sources named
  // once, and it has not been tried on real conversations yet. It is pinned
  // all the same, so that a change to it is a change someone decided.
  it('is, for a conversation, the wording that was written down', () => {
    const hash = createHash('sha256')
      .update(verifyRequest('{CONVERSATION_NO_REASONING}', true), 'utf8')
      .digest('hex')
    expect(hash).toBe(
      '90160ed82f902cefcde5498bbda8ee0ffa8d339984711ed320b4bba581099976'
    )
  })
})
