import type { ServerContext } from '@modelcontextprotocol/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listAccountsMock, elicitWithFallbackMock } = vi.hoisted(() => ({
  listAccountsMock: vi.fn(),
  elicitWithFallbackMock: vi.fn()
}))

vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({
    listAccounts: listAccountsMock
  })
}))

vi.mock('@n24q02m/hull/extensions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@n24q02m/hull/extensions')>()
  return {
    ...actual,
    elicitWithFallback: elicitWithFallbackMock
  }
})

import { confirmSensitiveOperation, resolveElicitedAccount } from './elicitation.js'

function fakeCtx(carriedState?: string): ServerContext {
  return {
    mcpReq: {
      requestState: () => carriedState
    }
  } as unknown as ServerContext
}

describe('elicitation helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('resolveElicitedAccount', () => {
    it('returns explicit account without consulting auth store', async () => {
      await expect(resolveElicitedAccount('gmail', { account: ' work@example.com ' })).resolves.toEqual({
        account: 'work@example.com'
      })
      expect(listAccountsMock).not.toHaveBeenCalled()
    })

    it('returns undefined when 0 or 1 accounts exist', async () => {
      listAccountsMock.mockResolvedValueOnce({ accounts: ['only@example.com'], primary: 'only@example.com' })
      await expect(resolveElicitedAccount('gmail', {})).resolves.toEqual({ account: undefined })
    })

    it('falls back to primary account when ctx is absent (CLI)', async () => {
      listAccountsMock.mockResolvedValueOnce({
        accounts: ['a@example.com', 'b@example.com'],
        primary: 'b@example.com'
      })
      await expect(resolveElicitedAccount('gmail', {})).resolves.toEqual({ account: 'b@example.com' })
    })

    it('uses carried requestState account when valid and present', async () => {
      listAccountsMock.mockResolvedValueOnce({
        accounts: ['a@example.com', 'b@example.com'],
        primary: 'a@example.com'
      })
      await expect(
        resolveElicitedAccount('gmail', { action: 'send' }, fakeCtx(JSON.stringify({ account: 'b@example.com' })))
      ).resolves.toEqual({ account: 'b@example.com' })
      expect(elicitWithFallbackMock).not.toHaveBeenCalled()
    })

    it('handles input_required, declined/cancelled, invalid account, and accepted selection', async () => {
      listAccountsMock.mockResolvedValue({
        accounts: ['a@example.com', 'b@example.com'],
        primary: 'a@example.com'
      })

      elicitWithFallbackMock.mockResolvedValueOnce({
        status: 'input_required',
        result: { inputRequired: { type: 'elicitation', schema: {} } }
      })
      const mrtr = await resolveElicitedAccount('gmail', { action: 'listMessages' }, fakeCtx('invalid-json'))
      expect(mrtr.earlyResult).toHaveProperty('inputRequired')

      elicitWithFallbackMock.mockResolvedValueOnce({ status: 'declined', data: undefined })
      const declined = await resolveElicitedAccount('gmail', {}, fakeCtx())
      expect(declined.earlyResult).toMatchObject({ isError: true })

      elicitWithFallbackMock.mockResolvedValueOnce({
        status: 'accepted',
        source: 'legacy',
        data: { account: 'c@bad.com' }
      })
      const invalid = await resolveElicitedAccount('gmail', {}, fakeCtx())
      expect(invalid.earlyResult).toMatchObject({ isError: true })

      elicitWithFallbackMock.mockResolvedValueOnce({
        status: 'accepted',
        source: 'mrtr',
        data: { account: 'b@example.com' }
      })
      const accepted = await resolveElicitedAccount('gmail', {}, fakeCtx())
      expect(accepted).toEqual({ account: 'b@example.com' })
    })
  })

  describe('confirmSensitiveOperation', () => {
    it('skips non-sensitive operations, missing action, and CLI calls without ctx', async () => {
      await expect(confirmSensitiveOperation('gmail', {})).resolves.toBeUndefined()
      await expect(confirmSensitiveOperation('gmail', { action: 'listMessages' }, fakeCtx())).resolves.toBeUndefined()
      await expect(confirmSensitiveOperation('gmail', { action: 'send' })).resolves.toBeUndefined()
      expect(elicitWithFallbackMock).not.toHaveBeenCalled()
    })

    it('handles input_required, declined, unconfirmed boolean, and confirmed outcomes', async () => {
      const args = { action: 'send', to: 'bob@example.com', subject: 'Hello' }

      elicitWithFallbackMock.mockResolvedValueOnce({
        status: 'input_required',
        result: { inputRequired: { type: 'elicitation', schema: {} } }
      })
      const mrtr = await confirmSensitiveOperation('gmail', args, fakeCtx(), 'a@example.com')
      expect(mrtr).toHaveProperty('inputRequired')
      expect(elicitWithFallbackMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          key: 'confirm_gmail_send',
          message: expect.stringContaining('account=a@example.com, to=bob@example.com, subject=Hello'),
          defaultValue: { confirmed: true }
        })
      )

      elicitWithFallbackMock.mockResolvedValueOnce({ status: 'cancelled', data: undefined })
      expect(await confirmSensitiveOperation('gmail', args, fakeCtx())).toMatchObject({ isError: true })

      elicitWithFallbackMock.mockResolvedValueOnce({ status: 'accepted', source: 'legacy', data: { confirmed: false } })
      expect(await confirmSensitiveOperation('gmail', args, fakeCtx())).toMatchObject({ isError: true })

      elicitWithFallbackMock.mockResolvedValueOnce({ status: 'accepted', source: 'mrtr', data: { confirmed: true } })
      expect(await confirmSensitiveOperation('gmail', args, fakeCtx())).toBeUndefined()
    })
  })
})
