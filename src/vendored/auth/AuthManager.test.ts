import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAuthenticatedClient = vi.hoisted(() => vi.fn())
vi.mock('../../auth/credential-state.js', () => ({ getAuth: () => ({ getAuthenticatedClient }) }))

import { runWithAccount } from '../../auth/account-context.js'
import { AuthManager } from './AuthManager.js'

describe('vendored AuthManager shim', () => {
  beforeEach(() => {
    getAuthenticatedClient.mockReset()
  })

  it('hands WorkspaceAuth the account selected for the current request', async () => {
    const client = { id: 'client-for-a' }
    getAuthenticatedClient.mockResolvedValue(client)

    const got = await runWithAccount('a@example.com', () => new AuthManager().getAuthenticatedClient())

    expect(got).toBe(client)
    expect(getAuthenticatedClient).toHaveBeenCalledExactlyOnceWith('a@example.com')
  })

  it('asks for the default account when no account was selected', async () => {
    getAuthenticatedClient.mockResolvedValue({})

    await new AuthManager().getAuthenticatedClient()

    expect(getAuthenticatedClient).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('keeps the upstream constructor, which vendored services call with their scopes', () => {
    expect(new AuthManager(['scope-a']).scopes).toEqual(['scope-a'])
    expect(new AuthManager().scopes).toEqual([])
  })
})
