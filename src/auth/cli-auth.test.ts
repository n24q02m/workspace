import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authCommand } from './cli-auth.js'

const startAddAccountMock = vi.fn()
vi.mock('./add-account.js', () => ({
  startAddAccount: (...args: unknown[]) => startAddAccountMock(...args)
}))

let stdout: string[]
let stderr: string[]

beforeEach(() => {
  vi.clearAllMocks()
  stdout = []
  stderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('authCommand --user validation', () => {
  it('rejects --user with no value (exit 2, nothing started)', async () => {
    await expect(authCommand(['--user'])).resolves.toBe(2)
    expect(stderr.join('')).toContain('--user requires a namespace value.')
    expect(startAddAccountMock).not.toHaveBeenCalled()
  })

  it('rejects --user followed by another flag (exit 2)', async () => {
    await expect(authCommand(['--user', '--verbose'])).resolves.toBe(2)
    expect(stderr.join('')).toContain('--user requires a namespace value.')
    expect(startAddAccountMock).not.toHaveBeenCalled()
  })

  it.each(['../escape', 'a b', 'a/b'])('rejects namespace %j with characters outside the allowed set', async (ns) => {
    await expect(authCommand(['--user', ns])).resolves.toBe(2)
    expect(stderr.join('')).toContain('--user must contain only letters, digits, ".", "_" or "-".')
    expect(startAddAccountMock).not.toHaveBeenCalled()
  })
})

describe('authCommand without --user', () => {
  it('runs consent directly, prints the authorization URL on stderr and the email on stdout', async () => {
    startAddAccountMock.mockResolvedValue({
      url: 'http://127.0.0.1:41234/',
      done: Promise.resolve('owner@example.com')
    })

    await expect(authCommand([])).resolves.toBe(0)

    expect(stderr.join('')).toContain(
      '[workspace] Google authorization required. Open http://127.0.0.1:41234/ in a browser to continue.'
    )
    expect(stdout.join('')).toBe('Added owner@example.com\n')
  })

  it('exits 1 with an auth failed message when consent fails', async () => {
    startAddAccountMock.mockResolvedValue({
      url: 'http://127.0.0.1:41234/',
      done: Promise.reject(new Error('boom'))
    })

    await expect(authCommand([])).resolves.toBe(1)
    expect(stderr.join('')).toContain('auth failed: boom')
    expect(stdout.join('')).toBe('')
  })
})

describe('authCommand --user', () => {
  it('runs consent for a valid namespace and exits 0', async () => {
    startAddAccountMock.mockResolvedValue({
      url: 'http://127.0.0.1:41234/',
      done: Promise.resolve('alice@example.com')
    })

    await expect(authCommand(['--user', 'alice'])).resolves.toBe(0)
    expect(startAddAccountMock).toHaveBeenCalledTimes(1)
    expect(stdout.join('')).toBe('Added alice@example.com\n')
  })

  it('exits 1 with an auth failed message when consent fails for the namespace', async () => {
    startAddAccountMock.mockRejectedValue(new Error('boom'))

    await expect(authCommand(['--user', 'alice'])).resolves.toBe(1)
    expect(stderr.join('')).toContain('auth failed: boom')
  })
})
