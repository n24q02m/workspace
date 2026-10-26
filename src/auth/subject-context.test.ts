import { localAuthContext, runWithAuthContext } from '@n24q02m/hull/token-auth'
import { describe, expect, it } from 'vitest'
import { currentAccount, runWithAccount } from './account-context.js'
import { currentSubject } from './subject-context.js'

function multiUser(namespace: string) {
  return runWithAuthContext({ ...localAuthContext(), uid: namespace, namespace, mode: 'multi' }, async () =>
    currentSubject()
  )
}

describe('subject-context', () => {
  it('is undefined in the local no-auth identity (stdio)', () => {
    expect(currentSubject()).toBeUndefined()
  })

  it('exposes the namespace of a multi-user caller inside its scope', async () => {
    expect(await multiUser('sub-1')).toBe('sub-1')
    expect(currentSubject()).toBeUndefined()
  })

  it('keeps concurrent callers isolated', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = runWithAuthContext(
      { ...localAuthContext(), uid: 'slow', namespace: 'slow', mode: 'multi' },
      async () => {
        await gate
        return currentSubject()
      }
    )
    expect(await multiUser('fast')).toBe('fast')
    release()
    expect(await slow).toBe('slow')
  })

  it('nests inside an account scope without either losing its value', async () => {
    const seen = await runWithAuthContext(
      { ...localAuthContext(), uid: 'sub-1', namespace: 'sub-1', mode: 'multi' },
      async () => runWithAccount('a@example.com', async () => ({ sub: currentSubject(), account: currentAccount() }))
    )
    expect(seen).toEqual({ sub: 'sub-1', account: 'a@example.com' })
  })
})
