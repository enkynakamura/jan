import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { UIMessage } from 'ai'
import type { VerificationRecord } from '@/lib/verifyReply'
import { useVerification } from '@/stores/verification-store'
import {
  VerificationDetails,
  VerificationPanel,
  VerifyButton,
} from '../VerificationPanel'

// Made-up findings: nothing here comes from a real conversation.
const record = (
  more: Partial<VerificationRecord> = {}
): VerificationRecord => ({
  at: 1,
  outcome: 'findings',
  seconds: 247.6,
  maxOutputTokens: 8192,
  truncated: false,
  model: { provider: 'strata', id: 'q8-model' },
  outputTokens: 6435,
  toolCalls: [],
  output: '',
  reasoning: '',
  entries: [
    {
      raw: '{}',
      finding: {
        verdict: 'contradicted',
        quote: 'The bridge opened in 1932.',
        source: 'Opened to traffic in 1934.',
        why: 'The source gives 1934.',
      },
      valid: true,
      rejections: [],
      occurrences: 1,
    },
    {
      raw: '{}',
      finding: {
        verdict: 'unsupported',
        quote: 'Its engineer was Marta Lindqvist.',
        source: null,
        why: 'No passage names the engineer.',
      },
      valid: true,
      rejections: [],
      occurrences: 0,
    },
    {
      raw: '{}',
      finding: {
        verdict: 'unsupported',
        quote: 'It is 412 meters long.',
        source: 'x',
      },
      valid: false,
      rejections: ['quote-not-found', 'source-not-null'],
    },
    { raw: 'That is all.', valid: false, rejections: ['not-json'] },
  ],
  marks: 1,
  ...more,
})
const message = (metadata?: Record<string, unknown>) =>
  ({
    id: 'reply-1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'The bridge opened in 1932.' }],
    metadata,
  }) as UIMessage

describe('VerificationDetails', () => {
  it('summarises the verification with the model, the time and the tokens', () => {
    render(<VerificationDetails record={record()} />)
    const panel = screen.getByTestId('verification')
    expect(panel).toHaveAttribute('data-outcome', 'findings')
    expect(panel.querySelector('summary')).toHaveTextContent(
      'Verification: 2 findings, 2 discarded; 1 mark written; 1 could not be marked · q8-model · 248 s · 6,435 tokens'
    )
  })

  it('names the model the engine answered with, when the record has it', () => {
    render(
      <VerificationDetails
        record={record({
          servedModel: 'the-model-loaded',
          entries: [],
          marks: 0,
        })}
      />
    )
    const summary = screen.getByTestId('verification').querySelector('summary')
    expect(summary).toHaveTextContent('· the-model-loaded · 248 s')
    expect(summary).not.toHaveTextContent('q8-model')
  })

  it('says of a finding taken as unverified what the verifier claimed and why', () => {
    const base = record().entries[0]
    render(
      <VerificationDetails
        record={record({
          entries: [
            { ...base, sourceDoubt: 'source-not-found' },
            { ...base, sourceDoubt: 'source-missing', occurrences: 0 },
            base,
          ],
        })}
      />
    )
    const items = screen.getAllByRole('listitem', { hidden: true })
    // The verdict is the verifier's; the note is the code's.
    expect(items[0]).toHaveTextContent(
      'Contradicted by the source (taken as unverified: the source passage was not found in the sources)'
    )
    expect(items[0]).toHaveTextContent('Source: Opened to traffic in 1934.')
    expect(items[0]).not.toHaveTextContent('not marked')
    expect(items[1]).toHaveTextContent(
      '(taken as unverified: no source passage was given) (not marked: the quote runs across two blocks of text)'
    )
    expect(items[2]).not.toHaveTextContent('taken as unverified')
  })

  it('lists every entry: verdict, quote, source and reason', () => {
    render(<VerificationDetails record={record()} />)
    const items = screen.getAllByRole('listitem', { hidden: true })
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent('Contradicted by the source')
    expect(items[0]).toHaveTextContent('The bridge opened in 1932.')
    expect(items[0]).toHaveTextContent('Source: Opened to traffic in 1934.')
    expect(items[0]).toHaveTextContent('The source gives 1934.')
    expect(items[0]).not.toHaveTextContent('not marked')
    expect(items[0]).not.toHaveTextContent('discarded')

    expect(items[1]).toHaveTextContent('Not supported by the sources')
    expect(items[1]).toHaveTextContent(
      '(not marked: the quote runs across two blocks of text)'
    )
    expect(items[1]).not.toHaveTextContent('Source:')

    expect(items[2]).toHaveTextContent(
      '(discarded: the quote is not in the answer; a source passage was given for an unsupported statement)'
    )
    expect(items[3]).toHaveTextContent('Not a finding: That is all.')
  })

  it('shows a verification that did not do its job, without a list', () => {
    render(
      <VerificationDetails
        record={record({
          outcome: 'error',
          error: 'connection refused',
          entries: [],
          marks: 0,
          model: undefined,
          outputTokens: undefined,
          seconds: 0.4,
        })}
      />
    )
    const panel = screen.getByTestId('verification')
    expect(panel.querySelector('summary')).toHaveTextContent(
      'Verification: failed (connection refused) · 0 s'
    )
    expect(panel.querySelector('summary')).toHaveClass('text-destructive')
    expect(screen.queryAllByRole('listitem', { hidden: true })).toHaveLength(0)
    expect(panel.querySelector('ol')).toBeNull()
  })
})

describe('VerificationPanel', () => {
  beforeEach(() => {
    useVerification.setState({ running: {}, records: {} })
  })

  it('shows nothing under a reply that was never verified', () => {
    const { container } = render(<VerificationPanel message={message()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the last verification kept with the reply', () => {
    render(
      <VerificationPanel
        message={message({
          verifications: [
            record({ outcome: 'stopped', entries: [], marks: 0 }),
            record({ outcome: 'no-findings', entries: [], marks: 0 }),
          ],
        })}
      />
    )
    expect(screen.getByTestId('verification')).toHaveAttribute(
      'data-outcome',
      'no-findings'
    )
  })

  it('shows the verification just made, before the reply is read again from the thread', () => {
    render(
      <VerificationPanel
        message={message({
          verifications: [
            record({ outcome: 'stopped', entries: [], marks: 0 }),
          ],
        })}
      />
    )
    expect(screen.getByTestId('verification')).toHaveAttribute(
      'data-outcome',
      'stopped'
    )
    act(() => useVerification.getState().setRecord('reply-1', record()))
    expect(screen.getByTestId('verification')).toHaveAttribute(
      'data-outcome',
      'findings'
    )
  })

  it('follows a verification while it runs, and shows the result when it ends', () => {
    render(<VerificationPanel message={message()} />)
    act(() =>
      useVerification
        .getState()
        .start('reply-1', 'thread-a', new AbortController())
    )
    expect(screen.getByTestId('verification-running')).toHaveTextContent(
      'Verifying: 0 characters so far'
    )
    act(() => useVerification.getState().progress('reply-1', 12345))
    expect(screen.getByTestId('verification-running')).toHaveTextContent(
      'Verifying: 12,345 characters so far'
    )
    expect(screen.queryByTestId('verification')).not.toBeInTheDocument()

    act(() => {
      useVerification.getState().setRecord('reply-1', record())
      useVerification
        .getState()
        .finish(
          'reply-1',
          useVerification.getState().running['reply-1'].controller
        )
    })
    expect(screen.queryByTestId('verification-running')).not.toBeInTheDocument()
    expect(screen.getByTestId('verification')).toBeInTheDocument()
  })

  it('does not show the verification of another reply', () => {
    act(() => {
      useVerification.getState().setRecord('reply-2', record())
      useVerification
        .getState()
        .start('reply-2', 'thread-a', new AbortController())
    })
    const { container } = render(<VerificationPanel message={message()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('VerifyButton', () => {
  beforeEach(() => {
    useVerification.setState({ running: {}, records: {} })
  })

  it('asks for the verification of its reply', () => {
    const onVerify = vi.fn()
    render(<VerifyButton messageId="reply-1" onVerify={onVerify} />)
    const button = screen.getByTestId('verify-message')
    expect(button).toHaveAttribute('title', 'Verify against the tool results')
    expect(button.querySelector('svg')).toHaveClass('tabler-icon-list-check')
    fireEvent.click(button)
    expect(onVerify).toHaveBeenCalledTimes(1)
    expect(onVerify).toHaveBeenCalledWith('reply-1')
  })

  it('stops the verification of its reply while it runs, and asks for no other', () => {
    const onVerify = vi.fn()
    const controller = new AbortController()
    const other = new AbortController()
    render(<VerifyButton messageId="reply-1" onVerify={onVerify} />)
    act(() => {
      useVerification.getState().start('reply-1', 'thread-a', controller)
      useVerification.getState().start('reply-2', 'thread-a', other)
    })
    const button = screen.getByTestId('verify-message')
    expect(button).toHaveAttribute('title', 'Stop the verification')
    expect(button.querySelector('svg')).toHaveClass(
      'tabler-icon-player-stop-filled'
    )

    fireEvent.click(button)
    expect(onVerify).not.toHaveBeenCalled()
    expect(controller.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    // Stopped: the button offers the verification again.
    expect(screen.getByTestId('verify-message')).toHaveAttribute(
      'title',
      'Verify against the tool results'
    )
  })

  it('is not taken by the verification of another reply', () => {
    const onVerify = vi.fn()
    render(<VerifyButton messageId="reply-1" onVerify={onVerify} />)
    act(() =>
      useVerification
        .getState()
        .start('reply-2', 'thread-a', new AbortController())
    )
    fireEvent.click(screen.getByTestId('verify-message'))
    expect(onVerify).toHaveBeenCalledWith('reply-1')
    expect(useVerification.getState().running['reply-2']).toBeDefined()
  })
})
