import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const h = vi.hoisted(() => ({ cap: 8192, setCap: vi.fn() }))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: () => ({
    verifyMaxOutputTokens: h.cap,
    setVerifyMaxOutputTokens: h.setCap,
  }),
}))

import {
  VerificationSettings,
  VERIFY_CAP_CHOICES,
} from '../VerificationSettings'
import { VERIFY_MAX_OUTPUT_TOKENS } from '@/lib/verifyReply'

const pressed = () =>
  screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.textContent)

describe('VerificationSettings', () => {
  beforeEach(() => {
    h.cap = 8192
    h.setCap.mockReset()
  })

  it('offers the caps, the one of a verification that is given none first', () => {
    render(<VerificationSettings />)

    expect(VERIFY_CAP_CHOICES[0]).toBe(VERIFY_MAX_OUTPUT_TOKENS)
    expect(
      screen.getAllByRole('button').map((button) => button.textContent)
    ).toEqual(['8,192', '16,384', '32,768'])
  })

  it('shows which cap is in use', () => {
    h.cap = 16384
    render(<VerificationSettings />)

    expect(pressed()).toEqual(['16,384'])
  })

  it('sets the cap that is clicked', () => {
    render(<VerificationSettings />)
    fireEvent.click(screen.getByRole('button', { name: '32,768' }))

    expect(h.setCap).toHaveBeenCalledTimes(1)
    expect(h.setCap).toHaveBeenCalledWith(32768)
  })
})
