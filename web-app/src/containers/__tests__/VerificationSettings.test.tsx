import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

const h = vi.hoisted(() => ({
  cap: 8192,
  setCap: vi.fn(),
  repetitions: 1,
  setRepetitions: vi.fn(),
}))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: () => ({
    verifyMaxOutputTokens: h.cap,
    setVerifyMaxOutputTokens: h.setCap,
    verifyRepetitions: h.repetitions,
    setVerifyRepetitions: h.setRepetitions,
  }),
}))

import {
  VerificationSettings,
  VERIFY_CAP_CHOICES,
  VERIFY_REPETITION_CHOICES,
} from '../VerificationSettings'
import { VERIFY_MAX_OUTPUT_TOKENS } from '@/lib/verifyReply'

const CAP = 'Output cap of the verifier'
const REPETITIONS = 'Repetitions'
const buttons = (group: string) =>
  within(screen.getByRole('group', { name: group })).getAllByRole('button')
const offered = (group: string) =>
  buttons(group).map((button) => button.textContent)
const pressed = (group: string) =>
  buttons(group)
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.textContent)
const click = (group: string, name: string) =>
  fireEvent.click(
    within(screen.getByRole('group', { name: group })).getByRole('button', {
      name,
    })
  )

describe('VerificationSettings', () => {
  beforeEach(() => {
    h.cap = 8192
    h.repetitions = 1
    h.setCap.mockReset()
    h.setRepetitions.mockReset()
  })

  it('offers the caps, the one of a verification that is given none first', () => {
    render(<VerificationSettings />)

    expect(VERIFY_CAP_CHOICES[0]).toBe(VERIFY_MAX_OUTPUT_TOKENS)
    expect(offered(CAP)).toEqual(['8,192', '16,384', '32,768'])
  })

  it('shows which cap is in use', () => {
    h.cap = 16384
    render(<VerificationSettings />)

    expect(pressed(CAP)).toEqual(['16,384'])
  })

  it('sets the cap that is clicked', () => {
    render(<VerificationSettings />)
    click(CAP, '32,768')

    expect(h.setCap).toHaveBeenCalledTimes(1)
    expect(h.setCap).toHaveBeenCalledWith(32768)
    expect(h.setRepetitions).not.toHaveBeenCalled()
  })

  it('offers from one to five repetitions', () => {
    render(<VerificationSettings />)

    expect(VERIFY_REPETITION_CHOICES).toEqual([1, 2, 3, 4, 5])
    expect(offered(REPETITIONS)).toEqual(['1', '2', '3', '4', '5'])
    expect(pressed(REPETITIONS)).toEqual(['1'])
  })

  it('shows how many repetitions are in use', () => {
    h.repetitions = 3
    render(<VerificationSettings />)

    expect(pressed(REPETITIONS)).toEqual(['3'])
    expect(pressed(CAP)).toEqual(['8,192'])
  })

  it('sets the repetitions that are clicked', () => {
    render(<VerificationSettings />)
    click(REPETITIONS, '5')

    expect(h.setRepetitions).toHaveBeenCalledTimes(1)
    expect(h.setRepetitions).toHaveBeenCalledWith(5)
    expect(h.setCap).not.toHaveBeenCalled()
  })
})
